import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss, TestClock } from '../src/index.ts'
import * as plans from '../src/plans.ts'
import { delay } from '../src/tools.ts'
import { enableClockOverride } from '../src/plans.ts'
import pg from 'pg'
import Contractor from '../src/contractor.ts'

// A fixed epoch keeps the tests independent of when they run.
const MINUTE = 60_000
const T0 = Date.parse('2026-01-01T12:00:30Z')

async function countJobs (boss: PgBoss, name: string): Promise<number> {
  const { rows } = await boss.getDb().executeSql(`SELECT count(*)::int AS n FROM ${ctx.schema}.job WHERE name = $1`, [name])
  return Number(rows[0].n)
}

async function dbTime (boss: PgBoss): Promise<number> {
  const { rows } = await boss.getDb().executeSql(plans.getTime(ctx.schema))
  return Number(rows[0].time)
}

// Real-time wait for I/O a tick started; tick itself never waits on I/O.
async function until (predicate: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('until: condition not met')
    await delay(10)
  }
}

describe('TestClock', function () {
  it('the database clock follows setTime and tick', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    expect(await dbTime(ctx.boss)).toBe(T0)

    await clock.tick(1500)
    expect(await dbTime(ctx.boss)).toBe(T0 + 1500)

    await clock.setTime(T0 - MINUTE)
    expect(await dbTime(ctx.boss)).toBe(T0 - MINUTE)
  })

  it('a debounced burst yields three jobs across a slot boundary and two within one', async function () {
    const boundary = T0 + 30_000
    const clock = new TestClock(boundary - 100)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })
    const queue = ctx.schema

    await ctx.boss.sendDebounced(queue, null, null, 60)
    await clock.tick(200)
    await ctx.boss.sendDebounced(queue, null, null, 60)
    await ctx.boss.sendDebounced(queue, null, null, 60)

    expect(await countJobs(ctx.boss, queue)).toBe(3)

    const mid = `${queue}_mid`
    await ctx.boss.createQueue(mid)
    await clock.setTime(boundary + 30_000)

    for (let i = 0; i < 3; i++) {
      await ctx.boss.sendDebounced(mid, null, null, 60)
    }

    expect(await countJobs(ctx.boss, mid)).toBe(2)
  })

  it('a deferred job becomes fetchable when the clock reaches startAfter', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await ctx.boss.send(ctx.schema, null, { startAfter: 60 })

    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)

    await clock.tick(MINUTE - 1)
    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)

    await clock.tick(1)
    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(1)
  })

  it('a handler is failed with the expiration message once the clock passes expireInSeconds', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const id = await ctx.boss.send(ctx.schema, null, { expireInSeconds: 5, retryLimit: 0 })
    assertTruthy(id)

    await ctx.boss.work(ctx.schema, () => new Promise(() => {}))
    await spy.waitForJobWithId(id, 'active')

    await clock.tick(5000)

    const job = await spy.waitForJobWithId(id, 'failed')
    expect((job.output as { message: string }).message).toBe('handler execution exceeded 5s')
  })

  it('a failed job is retried only after retryDelay has elapsed on the clock', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await ctx.boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 30 })

    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)
    await ctx.boss.fail(ctx.schema, job.id)

    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)

    await clock.tick(30_000)

    const [retried] = await ctx.boss.fetch(ctx.schema)
    expect(retried?.id).toBe(job.id)
  })

  it('a dead-lettered job is stamped on the clock and fetchable at once', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })
    const dlq = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(dlq)

    await ctx.boss.send(ctx.schema, null, { retryLimit: 0, deadLetter: dlq })
    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)
    await ctx.boss.fail(ctx.schema, job.id)

    // T0 is behind real time, so a column default would stamp the copy in the clock's future.
    const { rows } = await ctx.boss.getDb().executeSql(`SELECT start_after, created_on FROM ${ctx.schema}.job WHERE name = $1`, [dlq])
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0].start_after).getTime()).toBe(T0)
    expect(new Date(rows[0].created_on).getTime()).toBe(T0)
    expect(await ctx.boss.fetch(dlq)).toHaveLength(1)
  })

  it('a cron schedule enqueues after ticking through its next occurrence', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: true, cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1 })

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    expect(await countJobs(ctx.boss, ctx.schema)).toBe(0)

    await clock.tick(MINUTE)
    await until(async () => (await countJobs(ctx.boss!, '__pgboss__send-it')) > 0)

    await clock.tick(1000)
    await until(async () => (await countJobs(ctx.boss!, ctx.schema)) > 0)

    expect(await countJobs(ctx.boss, ctx.schema)).toBeGreaterThanOrEqual(1)
  })

  it('moving the clock backwards defers a job that was due', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await ctx.boss.send(ctx.schema, null, { startAfter: 60, retryLimit: 1 })
    await clock.setTime(T0 + MINUTE)
    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)
    // The retry re-queues the job with start_after at the clock's current reading.
    await ctx.boss.fail(ctx.schema, job.id)

    await clock.setTime(T0)
    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)

    await clock.setTime(T0 + MINUTE)
    const [retried] = await ctx.boss.fetch(ctx.schema)
    expect(retried?.id).toBe(job.id)
  })

  it('a year-long jump expires retention and files stats under the jumped-to day', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, persistQueueStats: true })

    await ctx.boss.send(ctx.schema, null, { retentionSeconds: 60 })
    await ctx.boss.supervise(ctx.schema)
    expect(await countJobs(ctx.boss, ctx.schema)).toBe(1)

    const later = T0 + 365 * 24 * 60 * MINUTE
    await clock.setTime(later)
    await ctx.boss.supervise(ctx.schema)

    expect(await countJobs(ctx.boss, ctx.schema)).toBe(0)
    const [snapshot] = await ctx.boss.getQueueStats(ctx.schema)
    expect(snapshot.capturedOn.getTime()).toBe(later)
  })

  helper.itPglite('start() refuses a TestClock on a custom adapter that cannot set up its sessions', async function () {
    const inner = await helper.getDb()
    const adapter = { executeSql: (text: string, values?: unknown[]) => inner.executeSql(text, values) }

    try {
      const boss = new PgBoss({ ...ctx.bossConfig, clock: new TestClock(T0), db: adapter })
      await expect(boss.start()).rejects.toThrow('setSessionStatements')
    } finally {
      await inner.close()
    }
  })

  helper.itPglite('start() refuses before it opens or migrates anything', async function () {
    const inner = await helper.getDb()
    const statements: string[] = []
    const adapter = {
      executeSql: (text: string, values?: unknown[]) => {
        statements.push(text)
        return inner.executeSql(text, values)
      }
    }

    try {
      const boss = new PgBoss({ ...ctx.bossConfig, clock: new TestClock(T0), db: adapter })
      await expect(boss.start()).rejects.toThrow('setSessionStatements')
      // The guard used to run after open() and the contractor, so a misconfigured test installed or
      // migrated a schema before being told its adapter could not carry the clock.
      expect(statements).toEqual([])
    } finally {
      await inner.close()
    }
  })

  helper.itPglite('a custom adapter is handed the statements its sessions need', async function () {
    const inner = await helper.getDb()
    const applied: string[] = []
    const adapter = {
      executeSql: (text: string, values?: unknown[]) => inner.executeSql(text, values),
      setSessionStatements: async (statements: string[]) => {
        applied.push(...statements)
        for (const statement of statements) await inner.executeSql(statement)
      }
    }

    try {
      ctx.boss = await helper.start({ ...ctx.bossConfig, clock: new TestClock(T0), db: adapter })
      expect(applied).toEqual([enableClockOverride()])
      expect(await dbTime(ctx.boss)).toBe(T0)
    } finally {
      await ctx.boss?.stop({ graceful: false })
      ctx.boss = undefined
      await inner.close()
    }
  })

  helper.itPglite('a pooled custom adapter that opts in every connection reads the clock on all of them', async function () {
    const pool = new pg.Pool({ ...ctx.bossConfig, max: 5 })
    let sessionStatements: string[] = []
    pool.on('connect', client => {
      for (const statement of sessionStatements) client.query(statement).catch(() => {})
    })
    const adapter = {
      executeSql: (text: string, values?: unknown[]) => pool.query(text, values),
      setSessionStatements: async (statements: string[]) => { sessionStatements = statements }
    }

    try {
      const clock = new TestClock(T0)
      ctx.boss = await helper.start({ ...ctx.bossConfig, clock, db: adapter })

      const reads = await Promise.all(Array.from({ length: 5 }, () => dbTime(ctx.boss!)))
      expect(reads).toEqual([T0, T0, T0, T0, T0])
    } finally {
      await ctx.boss?.stop({ graceful: false })
      ctx.boss = undefined
      await pool.end()
    }
  })

  it('attaching leaves a user table named clock alone', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    const db = await helper.getDb()

    try {
      // A TestClock used to create its table as `${schema}.clock` with IF NOT EXISTS, then DELETE
      // FROM it - so a table already sitting under that name had its rows wiped and was dropped on
      // release. The clock table is named for pg-boss now, and nothing touches this one.
      await db.executeSql(`CREATE TABLE ${ctx.schema}.clock (now timestamptz NOT NULL, note text)`)
      await db.executeSql(`INSERT INTO ${ctx.schema}.clock (now, note) VALUES (now(), 'user data')`)

      const other = await helper.start({ ...ctx.bossConfig, clock, noDefault: true })
      await other.stop({ graceful: false })

      const rows = await db.executeSql(`SELECT note FROM ${ctx.schema}.clock`)
      expect(rows.rows.map((r: { note: string }) => r.note)).toEqual(['user data'])
    } finally {
      await db.close()
    }
  })

  it('a clock that is never released is reported as drift, with the override named', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })
    await ctx.boss.stop({ graceful: false })
    ctx.boss = undefined

    const db = await helper.getDb()

    try {
      // Exactly the state attach() leaves, which a run killed before disposing its handle keeps:
      // the override body installed on job_now() and its backing table still there.
      await db.executeSql(`
        CREATE TABLE ${plans.clockTable(ctx.schema)} (now timestamp with time zone NOT NULL);
        ${plans.createClockFunction(ctx.schema, { replace: true, body: plans.clockOverrideBody(ctx.schema) })}
      `)

      const source = await db.executeSql(plans.getClockFunctionSource(ctx.schema))
      expect(plans.clockFunctionIsOverridden(source.rows[0]?.source)).toBe(true)

      const contractor = new Contractor(db, { ...ctx.bossConfig, schema: ctx.schema })
      const report = await contractor.detectDrift()
      const mismatch = report.mismatchedFunctions.find(f => f.name === 'job_now')

      expect(report.ok).toBe(false)
      assertTruthy(mismatch)
      expect(plans.clockFunctionIsOverridden(mismatch.actualDefinition)).toBe(true)

      // And doctor's suggested SQL is the real fix: it clears both halves of the leftover.
      await db.executeSql(plans.restoreClockFunction(ctx.schema))

      const healed = await contractor.detectDrift()
      expect(healed.mismatchedFunctions.find(f => f.name === 'job_now')).toBeUndefined()

      const table = await db.executeSql(`SELECT to_regclass('${plans.clockTable(ctx.schema)}')::text AS t`)
      expect(table.rows[0].t).toBe(null)
    } finally {
      await db.close()
    }
  })

  // PGlite is one session, so the opt-in from attach() is visible to every instance sharing it.
  helper.itPglite('an instance without a clock keeps real time on a schema another instance holds on fake time', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })
    const plain = await helper.start({ ...ctx.bossConfig, noDefault: true })

    try {
      expect(await dbTime(ctx.boss)).toBe(T0)
      expect(Math.abs(await dbTime(plain) - Date.now())).toBeLessThan(60_000)
    } finally {
      await plain.stop({ graceful: false })
    }
  })

  it('a graceful stop() returns on real time while a handler hangs', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)
    await ctx.boss.work(ctx.schema, () => new Promise(() => {}))
    await spy.waitForJobWithId(id, 'active')

    const started = Date.now()
    await ctx.boss.stop({ timeout: 1000 })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  // CockroachDB rewrites the override body, so the drift substitution cannot match there.
  it.skipIf(helper.isCockroachDb)('schema drift is clean while attached and after the clock is released', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    expect((await ctx.boss.detectSchemaDrift()).ok).toBe(true)

    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    expect((await ctx.boss.detectSchemaDrift()).ok).toBe(true)
  })

  it('one clock drives two instances on one schema and releases the schema with the last', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })
    const second = await helper.start({ ...ctx.bossConfig, clock, noDefault: true })

    await clock.setTime(T0 + MINUTE)
    expect(await dbTime(ctx.boss)).toBe(T0 + MINUTE)
    expect(await dbTime(second)).toBe(T0 + MINUTE)

    await second.stop({ graceful: false })
    expect(await dbTime(ctx.boss)).toBe(T0 + MINUTE)

    await ctx.boss.stop({ graceful: false })

    const db = await helper.getDb()
    try {
      const { rows } = await db.executeSql(plans.getTime(ctx.schema))
      expect(Math.abs(Number(rows[0].time) - Date.now())).toBeLessThan(60_000)
    } finally {
      await db.close()
    }
  })
})
