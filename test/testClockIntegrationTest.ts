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

  // queue and subscription metadata is the last thing pg-boss wrote without naming its timestamps,
  // so these rows took real time from their column defaults while every job row took fake time.
  it('queue and subscription rows are stamped on the clock', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    const queue = `${ctx.schema}_clock_queue`
    await ctx.boss.createQueue(queue)
    await ctx.boss.subscribe('clock_event', queue)

    const db = ctx.boss.getDb()
    const { rows: queues } = await db.executeSql(`SELECT created_on, updated_on FROM ${ctx.schema}.queue WHERE name = $1`, [queue])
    expect(queues).toHaveLength(1)
    expect(new Date(queues[0].created_on).getTime()).toBe(T0)
    expect(new Date(queues[0].updated_on).getTime()).toBe(T0)

    const { rows: subs } = await db.executeSql(`SELECT created_on, updated_on FROM ${ctx.schema}.subscription WHERE name = $1`, [queue])
    expect(subs).toHaveLength(1)
    expect(new Date(subs[0].created_on).getTime()).toBe(T0)
    expect(new Date(subs[0].updated_on).getTime()).toBe(T0)

    // The conflict branch already named updated_on, so this only pins that insert and update agree.
    await clock.tick(MINUTE)
    await ctx.boss.subscribe('clock_event', queue)
    const { rows: again } = await db.executeSql(`SELECT created_on, updated_on FROM ${ctx.schema}.subscription WHERE name = $1`, [queue])
    expect(new Date(again[0].created_on).getTime()).toBe(T0)
    expect(new Date(again[0].updated_on).getTime()).toBe(T0 + MINUTE)
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

  it('a forward setTime expires a hung handler on the next tick, as the database would', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const id = await ctx.boss.send(ctx.schema, null, { expireInSeconds: 5, retryLimit: 0 })
    assertTruthy(id)

    await ctx.boss.work(ctx.schema, () => new Promise(() => {}))
    await spy.waitForJobWithId(id, 'active')

    await clock.setTime(T0 + 60 * MINUTE)
    await clock.tick(1000)

    const job = await spy.waitForJobWithId(id, 'failed')
    expect((job.output as { message: string }).message).toBe('handler execution exceeded 5s')
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

  it('a restart over a pool the previous run left open still reads the clock', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    expect(await dbTime(ctx.boss)).toBe(T0)

    // stop({ close: false }) keeps the pool, so the second start() hands its statements to a db that
    // is already open, holding idle connections that will never re-run the connect hook. That used
    // to be an assert; the set is made total instead, because nothing is checked out during start().
    await ctx.boss.stop({ close: false, graceful: false })
    await ctx.boss.start()

    // Concurrent, so the reads land on different pooled connections - including the ones the first
    // run opened. A set that reached only the new connections would show real time on some of them.
    await clock.setTime(T0 + MINUTE)
    const reads = await Promise.all(Array.from({ length: 5 }, () => dbTime(ctx.boss!)))
    expect(reads).toEqual([T0 + MINUTE, T0 + MINUTE, T0 + MINUTE, T0 + MINUTE, T0 + MINUTE])
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

  helper.itPglite('clears the session opt-in when start() fails before the clock is attached', async function () {
    const pool = new pg.Pool({ ...ctx.bossConfig, max: 2 })
    let sessionStatements: string[] = []
    const db = {
      executeSql: (text: string, values?: unknown[]) => pool.query(text, values),
      setSessionStatements: async (statements: string[]) => { sessionStatements = statements }
    }

    try {
      // migrate: false over a schema nothing installed, so the contractor's check throws - after
      // #doStart has already declared the opt-in and before there is any attachment to dispose.
      const boss = new PgBoss({ ...ctx.bossConfig, db, clock: new TestClock(T0), migrate: false, supervise: false, schedule: false })
      await expect(async () => { await boss.start() }).rejects.toThrow()
      expect(sessionStatements).toEqual([enableClockOverride()])

      // Left behind, it would stamp the opt-in on every connection this adapter opens from here on,
      // including a later run that was never given a clock.
      await boss.stop({ graceful: false })
      expect(sessionStatements).toEqual([])
    } finally {
      await pool.end()
    }
  })

  helper.itPglite('clears the session opt-in even when releasing the clock fails', async function () {
    const pool = new pg.Pool({ ...ctx.bossConfig, max: 2 })
    let sessionStatements: string[] = []
    let failRelease = false
    const db = {
      executeSql: (text: string, values?: unknown[]) => {
        if (failRelease && text.includes(`DROP TABLE IF EXISTS ${plans.clockTable(ctx.schema)}`)) {
          throw new Error('connection terminated')
        }
        return pool.query(text, values)
      },
      setSessionStatements: async (statements: string[]) => { sessionStatements = statements }
    }

    try {
      const boss = new PgBoss({ ...ctx.bossConfig, db, clock: new TestClock(T0), supervise: false, schedule: false })
      await boss.start()
      expect(sessionStatements).toEqual([enableClockOverride()])

      // The release is one statement over the network like any other, and it can fail. Whether it
      // did or not, the declaration #doStart made has to come back off.
      failRelease = true
      await expect(async () => { await boss.stop({ graceful: false }) }).rejects.toThrow('connection terminated')
      expect(sessionStatements).toEqual([])
    } finally {
      failRelease = false
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

  it('the override is found without pg_get_functiondef, so doctor --fix is not blind on CockroachDB', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })
    await ctx.boss.stop({ graceful: false })
    ctx.boss = undefined

    const db = await helper.getDb()

    try {
      await db.executeSql(`
        CREATE TABLE ${plans.clockTable(ctx.schema)} (now timestamp with time zone NOT NULL);
        ${plans.createClockFunction(ctx.schema, { replace: true, body: plans.clockOverrideBody(ctx.schema) })}
      `)

      // The drift report reaches the override through pg_get_functiondef, which CockroachDB does
      // not support - the whole function check is skipped there, so a leftover never reaches the
      // report and --fix used to say there was nothing to repair. This probe reads prosrc, which is
      // also why it is a positive test for the override rather than a diff against the canonical
      // body: CockroachDB rewrites what it stores.
      const contractor = new Contractor(db, { ...ctx.bossConfig, schema: ctx.schema })
      expect(await contractor.detectClockOverride()).toBe(true)

      await contractor.restoreClockFunction()
      expect(await contractor.detectClockOverride()).toBe(false)
    } finally {
      await db.close()
    }
  })

  it('treats a pg_proc it cannot read as no override, not as a problem', async function () {
    // The probe is best-effort in both directions: a backend without pg_proc, or a role that cannot
    // read it, is not evidence of a leftover override. Saying yes there would have doctor --fix
    // rewrite job_now() on no evidence at all.
    const unreadable = {
      executeSql: async () => { throw new Error('permission denied for table pg_proc') }
    }

    const contractor = new Contractor(unreadable as any, { ...ctx.bossConfig, schema: ctx.schema })

    expect(await contractor.detectClockOverride()).toBe(false)
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

  // One tick has to carry a worker through a fetch that misses, the re-armed poll, and the fetch
  // that hits. With every statement slow, the first fetch outlives a tick that does not wait for it.
  helper.itPglite('one tick fires a job due just after the poll it fired, on a slow database', async function () {
    const pool = new pg.Pool({ ...ctx.bossConfig, max: 5 })
    let sessionStatements: string[] = []
    pool.on('connect', client => {
      for (const statement of sessionStatements) client.query(statement).catch(() => {})
    })
    const db = {
      executeSql: async (text: string, values?: unknown[]) => {
        await delay(50)
        return pool.query(text, values)
      },
      setSessionStatements: async (statements: string[]) => { sessionStatements = statements }
    }

    try {
      const clock = new TestClock(T0)
      ctx.boss = await helper.start({ ...ctx.bossConfig, clock, db, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const id = await ctx.boss.send(ctx.schema, null, { startAfter: new Date(T0 + MINUTE + 200) })
      assertTruthy(id)
      await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {})

      await clock.setTime(T0 + MINUTE)
      await clock.tick(500)

      await Promise.race([
        spy.waitForJobWithId(id, 'completed'),
        delay(3000).then(() => { throw new Error('job did not complete after one tick') })
      ])
    } finally {
      await ctx.boss?.stop({ graceful: false })
      ctx.boss = undefined
      await pool.end()
    }
  })

  it('hands back the adapter as given unless the clock is attachable', function () {
    const adapter = { executeSql: async () => ({ rows: [] }) }

    expect(new PgBoss({ ...ctx.bossConfig, db: adapter }).getDb()).toBe(adapter)

    const tracked = new PgBoss({ ...ctx.bossConfig, db: adapter, clock: new TestClock(T0) }).getDb()
    expect(tracked).not.toBe(adapter)
    expect(typeof tracked.executeSql).toBe('function')
  })

  helper.itPglite('one tick completes a job for a transactional worker', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    await ctx.boss.work(ctx.schema, { transactional: true, pollingIntervalSeconds: 0.5 }, async () => {})
    const id = await ctx.boss.send(ctx.schema, null)
    assertTruthy(id)

    await clock.tick(500)

    await Promise.race([
      spy.waitForJobWithId(id, 'completed'),
      delay(3000).then(() => { throw new Error('job did not complete after one tick') })
    ])
  })

  // Handlers are not waited for, and a statement a transactional handler runs through its tx is
  // part of the handler, even though it shares the connection pg-boss completes the batch on.
  helper.itPglite('statements a transactional handler runs do not hold up a tick', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, __test__enableSpies: true })
    const boss = ctx.boss
    const spy = boss.getSpy(ctx.schema)

    const id = await boss.send(ctx.schema, null)
    assertTruthy(id)
    await boss.work(ctx.schema, { transactional: true, pollingIntervalSeconds: 0.5 }, async ([job], tx) => {
      await tx.executeSql('SELECT pg_sleep(2)')
      await boss.complete(ctx.schema, job.id, null, { db: tx })
    })
    await spy.waitForJobWithId(id, 'active')

    const started = performance.now()
    await clock.tick(500)
    expect(performance.now() - started).toBeLessThan(1500)

    // Settled by the handler through its tx, so pg-boss must still recognize that tx as the batch's.
    await spy.waitForJobWithId(id, 'completed')
  })
})
