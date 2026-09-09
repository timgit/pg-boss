import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'

// A clock read that is not qualified with the schema. `.now(` (Date.now, s.now) is excluded.
const BARE_NOW = /(^|[^.\w])now\s*\(/

describe('schema clock', function () {
  it('every runtime statement reads the clock through the schema function', function () {
    const schema = 's'
    const samples: Record<string, string> = {
      getTime: plans.getTime(schema),
      insertJobs: plans.insertJobs(schema, { table: 'job', name: 'q' }),
      fetchNextJob: plans.fetchNextJob({ schema, table: 'job', name: 'q', policy: 'standard', limit: 1, includeMetadata: false } as any).text,
      failJobsByTimeout: plans.failJobsByTimeout(schema, 'job', ['q']),
      failJobsByHeartbeat: plans.failJobsByHeartbeat(schema, 'job', ['q']),
      deletion: plans.deletion(schema, 'job', ['q']),
      retryJobs: plans.retryJobs(schema, 'job'),
      trySetCronTime: plans.trySetCronTime(schema, 60),
      schedule: plans.schedule(schema),
      deleteOldWarnings: plans.deleteOldWarnings(schema, 7)
    }

    // retryJobs flips a failed job back to retry and clears completed_on without writing any
    // timestamp, so it has no clock read to qualify; every other sample must have one.
    const NO_CLOCK_READ = new Set(['retryJobs'])

    for (const [name, sql] of Object.entries(samples)) {
      expect(sql).not.toMatch(BARE_NOW)
      if (!NO_CLOCK_READ.has(name)) {
        expect(sql).toContain(`${schema}.now()`)
      }
    }
  })

  helper.itPostgresOnly('is inlined by the planner, so a fetch predicate reads pg_catalog.now() directly', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = await helper.getDb()

    // The predicate fetchNextJob emits. Whether it lands as an Index Cond or a Filter depends on
    // statistics for a fresh empty table, so assert the inlined text wherever it appears.
    const { rows } = await db.executeSql(
      `EXPLAIN (VERBOSE, COSTS OFF) SELECT id FROM ${ctx.schema}.job WHERE name = 'q' AND start_after <= ${ctx.schema}.now()`
    )
    const plan = rows.map((r: any) => r['QUERY PLAN']).join('\n')

    expect(plan).toMatch(/start_after <= now\(\)/)
    expect(plan).not.toContain(`${ctx.schema}.now(`)
  })

  it('agrees with pg_catalog.now() inside one statement', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = await helper.getDb()

    const { rows } = await db.executeSql(`SELECT ${ctx.schema}.now() = pg_catalog.now() AS same`)

    expect(rows[0].same).toBe(true)
  })
})
