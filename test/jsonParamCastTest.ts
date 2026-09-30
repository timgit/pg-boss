import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { ctx } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import type { IDatabase } from '../src/types.ts'

// Some drivers infer a bind parameter's type from the cast in front of it, and that inference cuts
// both ways depending on what pg-boss binds.
//
// Where pg-boss binds an already-stringified payload, `$N::json` reads as "this is JSON" and the
// string gets encoded a second time: Postgres receives a JSON scalar and json_to_recordset() fails
// with 22023. That is #880 (Bun.SQL, oven-sh/bun#28819). `$N::text::json` pins the inference to
// text and changes nothing for the drivers that send the value as text either way.
//
// Where pg-boss binds a plain JS object, that same cast is what makes such a driver serialize it as
// JSON at all - through text it falls back to String(value) and sends `[object Object]`. PGlite
// does this, so both directions need pinning, which is what this file is for.
//
// No Bun in CI: the runtime half models the double-encoding driver with a wrapper, the way
// distributedDatabaseTest wraps a connection for CockroachDB's INT8-as-string behaviour.

const DIRECT_JSON_CAST = /\$\d+::jsonb?\b/
const TEXT_ROUTED_JSON_CAST = /\$\d+::text::jsonb?\b/

// 22023 invalid_parameter_value - what json_to_recordset() raises when handed a JSON scalar.
const INVALID_PARAMETER_VALUE = '22023'

const schema = 'pgboss'
const table = plans.COMMON_JOB_TABLE

// Statements whose JSON parameter is bound as a string.
const textRouted: Array<[string, string]> = [
  ['completeJobsWithOutputs', plans.completeJobsWithOutputs(schema, table)],
  ['completeJobsWithOutputsDistributed', plans.completeJobsWithOutputsDistributed(schema, table)],
  ['insertJobs', plans.insertJobs(schema, { table, name: 'q' })],
  ['failJobsByIdWithOutputs', plans.failJobsByIdWithOutputs(schema, table)],
  ['deadLetterJobsByIdWithOutputs', plans.deadLetterJobsByIdWithOutputs(schema, table)],
  ['updateJob', plans.updateJob(schema, table, 'q', 'id', 'newest')],
  ['insertDependencies', plans.insertDependencies(schema)],
  ['setScheduleLastJobIds', plans.setScheduleLastJobIds(schema)],
  ['setScheduleKinds', plans.setScheduleKinds(schema)],
  // Both share redriveWhere's data filter.
  ['redriveJobs', plans.redriveJobs(schema, table)],
  ['previewRedrive', plans.previewRedrive(schema, table)],
  // Left uncast, an inferring driver takes jsonb from the `@>` beside it, the same as `::jsonb`.
  ['findJobs (by data)', plans.findJobs(schema, table, { queued: false, byKey: false, byData: true, byId: false })],
  // buildFetchParams renders the tier parameter only with groupConcurrency.tiers set, and builds it
  // by concatenation - which is why a grep for `$N::jsonb` does not turn it up.
  ['fetchNextJob (group concurrency tiers)', plans.fetchNextJob({
    schema,
    table,
    name: 'q',
    policy: undefined,
    limit: 1,
    ignoreSingletons: null,
    groupConcurrency: { default: 1, tiers: { enterprise: 3 } }
  }).text]
]

// Statements whose JSON parameter is bound as a plain JS object, left for the driver to serialize.
const driverSerialized: Array<[string, string]> = [
  ['updateQueue', plans.updateQueue(schema)],
  ['completeJobs', plans.completeJobs(schema, table)],
  ['completeJobs (includeQueued)', plans.completeJobs(schema, table, true)],
  // Wraps the same completeJobsUpdate body; this is the one the CockroachDB leg actually runs.
  ['completeJobsDistributed', plans.completeJobsDistributed(schema, table)],
  ['failJobsById', plans.failJobsById(schema, table)]
]

describe('json bind parameter casts', function () {
  for (const [name, sql] of textRouted) {
    it(`${name} routes its json parameter through text`, function () {
      expect(sql).not.toMatch(DIRECT_JSON_CAST)
      expect(sql).toMatch(TEXT_ROUTED_JSON_CAST)
    })
  }

  for (const [name, sql] of driverSerialized) {
    it(`${name} keeps its json parameter cast direct`, function () {
      expect(sql).toMatch(DIRECT_JSON_CAST)
      expect(sql).not.toMatch(TEXT_ROUTED_JSON_CAST)
    })
  }

  // Guards the guards: a typo in either pattern leaves every assertion above trivially true.
  it('the patterns recognise the casts they are looking for', function () {
    expect('SELECT $1::json').toMatch(DIRECT_JSON_CAST)
    expect('SELECT $2::jsonb').toMatch(DIRECT_JSON_CAST)
    expect('SELECT $1::text::json').not.toMatch(DIRECT_JSON_CAST)
    expect('SELECT $2::text::jsonb').not.toMatch(DIRECT_JSON_CAST)

    expect('SELECT $1::text::json').toMatch(TEXT_ROUTED_JSON_CAST)
    expect('SELECT $2::text::jsonb').toMatch(TEXT_ROUTED_JSON_CAST)
    expect('SELECT $1::json').not.toMatch(TEXT_ROUTED_JSON_CAST)
  })
})

// Re-encodes a string bound in front of a json cast, and leaves objects alone - a driver of this
// kind serializes those correctly.
//
// `textRoutedHits` counts the strings it saw bound in front of a `::text::json` cast: every one of
// those is a parameter that would have been double-encoded before this change. Asserting it is
// non-zero is what stops the lifecycle test passing vacuously - without it, a boss that quietly
// ignored the `db` option would look just as green.
function doubleEncodesJsonParams (db: IDatabase): { db: IDatabase, textRoutedHits: () => number } {
  let hits = 0

  const wrapped: IDatabase = {
    executeSql (text: string, values?: unknown[]) {
      const encoded = values?.map((value, index) => {
        if (typeof value !== 'string') return value

        if (new RegExp(`\\$${index + 1}::text::jsonb?\\b`).test(text)) hits++

        return new RegExp(`\\$${index + 1}::jsonb?\\b`).test(text) ? JSON.stringify(value) : value
      })

      return db.executeSql(text, encoded)
    }
  }

  return { db: wrapped, textRoutedHits: () => hits }
}

// Owned by the file rather than the test: hooks.ts stops the boss in afterEach, and the boss is
// still talking to this connection when it does.
let rawDb: Awaited<ReturnType<typeof helper.getDb>> | undefined

afterAll(async () => {
  if (rawDb) await rawDb.close()
})

describe('json bind parameters under a type-inferring driver', function () {
  it('runs the job lifecycle through a double-encoding driver', async function () {
    rawDb ??= await helper.getDb()
    const driver = doubleEncodesJsonParams(rawDb)
    ctx.boss = await helper.start({ ...ctx.bossConfig, db: driver.db })

    const queue = ctx.schema

    // insertJobs, the plan #880 reported, through both of its entry points
    const jobId = await ctx.boss.send(queue, { hello: 'world' })
    helper.assertTruthy(jobId)
    await ctx.boss.insert(queue, [{ data: { hello: 'insert' } }])

    // updateJob, the other text-routed plan reachable from a public method. The id is new, so
    // this misses the update and inserts - three jobs now, and the fetch below has to take all
    // of them: fetch orders on (priority, created_on) with no tiebreaker, and PGlite's now() is
    // coarse enough that the three can share a created_on. Taking a subset would pick an
    // arbitrary one. (separateTimestamps only wraps send/insert, not upsert.)
    await ctx.boss.upsert(queue, { hello: 'upserted' }, { id: randomUUID() })

    const jobs = await ctx.boss.fetch(queue, { batchSize: 3 })
    expect(jobs).toHaveLength(3)

    const sent = jobs.find(job => job.id === jobId)
    helper.assertTruthy(sent)
    expect(sent.data).toEqual({ hello: 'world' })

    // the object-bound outputs, which have to keep round-tripping
    await ctx.boss.complete(queue, jobs[0].id, { done: true })
    await ctx.boss.fail(queue, jobs[1].id, { because: 'test' })

    const completed = await ctx.boss.getJobById(queue, jobs[0].id)
    helper.assertTruthy(completed)
    expect(completed.output).toEqual({ done: true })

    await ctx.boss.updateQueue(queue, { retryLimit: 7 })
    const updated = await ctx.boss.getQueue(queue)
    helper.assertTruthy(updated)
    expect(updated.retryLimit).toBe(7)

    // The driver above only matters if pg-boss actually went through it. Every hit is a string
    // bound in front of a `::text::json` cast - the shape that used to be double-encoded.
    expect(driver.textRoutedHits()).toBeGreaterThan(0)
  })

  it('breaks on a direct $N::json cast, and not on the text-routed one', async function () {
    rawDb ??= await helper.getDb()
    const { db } = doubleEncodesJsonParams(rawDb)
    const payload = JSON.stringify([{ id: 1 }, { id: 2 }])

    // Negative control: the statement pg-boss used to emit. This is what establishes that the
    // wrapper can break a direct cast at all - it drives executeSql itself, so it says nothing
    // about pg-boss's own path. That part is textRoutedHits() in the test above.
    await expect(db.executeSql('SELECT * FROM json_to_recordset($1::json) AS x (id int)', [payload]))
      .rejects.toMatchObject({ code: INVALID_PARAMETER_VALUE })

    const { rows } = await db.executeSql('SELECT * FROM json_to_recordset($1::text::json) AS x (id int)', [payload])
    expect(rows).toEqual([{ id: 1 }, { id: 2 }])
  })
})
