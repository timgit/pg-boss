import { it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import pg from 'pg'
import type { PgBoss } from '../src/index.ts'

// The queue-stats aggregate reads the whole job table, and while it runs it advertises a snapshot
// autovacuum cannot vacuum past. Left unpaced it becomes the "continuously running analytical
// query" that keeps the horizon pinned forever; these tests cover the gate that stops it.
//
// Every case drives the duration through __test__monitor_stats_seconds rather than by building a
// job table big enough to take six real seconds: autovacuum_naptime is SIGHUP-level and a test
// cannot move it, so crossing the threshold honestly would mean a multi-GB fixture. The naptime
// read, the threshold comparison and the backoff arithmetic under test are all the real ones.
const NAPTIME_SECONDS = 60

async function query (sql: string, values: unknown[] = []) {
  const db = await helper.getDb()

  try {
    const { rows } = await db.executeSql(sql, values)
    return rows
  } finally {
    await db.close()
  }
}

async function backoffUntil (schema: string): Promise<Date | null> {
  const rows = await query(`SELECT monitor_backoff_on FROM ${schema}.version`)
  return rows.at(0)?.monitor_backoff_on ?? null
}

async function monitorOn (schema: string, queue: string): Promise<Date | null> {
  const rows = await query(`SELECT monitor_on FROM ${schema}.queue WHERE name = $1`, [queue])
  return rows.at(0)?.monitor_on ?? null
}

async function monitorClaimOn (schema: string, queue: string): Promise<Date | null> {
  const rows = await query(`SELECT monitor_claim_on FROM ${schema}.queue WHERE name = $1`, [queue])
  return rows.at(0)?.monitor_claim_on ?? null
}

async function warnings (schema: string) {
  return await query(`SELECT message, data FROM ${schema}.warning WHERE type = 'monitor_backoff' ORDER BY created_on`)
}

async function startBoss (options: object = {}): Promise<PgBoss> {
  const boss = ctx.boss = await helper.start({
    ...ctx.bossConfig,
    noDefault: true,
    supervise: false,
    persistWarnings: true,
    ...options
  })

  await boss.createQueue('backoff')

  return boss
}

helper.describePostgresOnly('monitor backoff', function () {
  it('stays out of the way for a pass inside the naptime budget', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 1 })

    await boss.supervise()

    // A second of aggregate against a 60s naptime leaves 59s of every interval free — a window no
    // autovacuum launcher phase can keep missing. Nothing to defend against, so nothing is written.
    expect(await backoffUntil(ctx.schema)).toBeNull()
    expect(await warnings(ctx.schema)).toHaveLength(0)
  })

  it('engages once a pass spends more than a tenth of a naptime pinning the horizon', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 90 })

    const before = Date.now()
    await boss.supervise()

    const until = await backoffUntil(ctx.schema)

    helper.assertTruthy(until)

    // 2 x naptime, because the launcher's tick is not the moment the cutoff is taken: the worker
    // still has to connect, pick its table list and get through whatever else is queued ahead.
    const seconds = (new Date(until).getTime() - before) / 1000

    expect(seconds).toBeGreaterThan(2 * NAPTIME_SECONDS - 10)
    expect(seconds).toBeLessThan(2 * NAPTIME_SECONDS + 10)
  })

  it('follows the pass duration once that outgrows two naptimes', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 300 })

    const before = Date.now()
    await boss.supervise()

    const until = await backoffUntil(ctx.schema)

    helper.assertTruthy(until)

    // A pass that pinned for 300s is followed by at least 300s free, holding the aggregate's duty
    // cycle at 50% rather than letting it climb with the table.
    const seconds = (new Date(until).getTime() - before) / 1000

    expect(seconds).toBeGreaterThan(290)
    expect(seconds).toBeLessThan(310)
  })

  it('caps the duration term so the counts cannot stall indefinitely', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 5000 })

    const before = Date.now()
    await boss.supervise()

    const until = await backoffUntil(ctx.schema)

    helper.assertTruthy(until)

    const seconds = (new Date(until).getTime() - before) / 1000

    expect(seconds).toBeGreaterThan(590)
    expect(seconds).toBeLessThan(610)
  })

  it('names the measurement and the naptime it was judged against', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 90 })

    await boss.supervise()

    const stored = await warnings(ctx.schema)

    expect(stored).toHaveLength(1)
    expect(stored[0].message).toContain('90.0s')
    expect(stored[0].message).toContain(`autovacuum_naptime of ${NAPTIME_SECONDS}s`)
    expect(Number(stored[0].data.backoffSeconds)).toBe(2 * NAPTIME_SECONDS)
    expect(Number(stored[0].data.naptimeSeconds)).toBe(NAPTIME_SECONDS)
  })

  it('holds off the next aggregate until the deadline passes', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 90, monitorIntervalSeconds: 1 })

    await boss.supervise()

    const claimed = await monitorOn(ctx.schema, 'backoff')

    helper.assertTruthy(claimed)

    // monitorIntervalSeconds is 1, so the interval gate alone would wave this straight through —
    // which is exactly the tuned-too-low case the backoff exists for. Manual supervise() is the
    // same path a cron or a CLI process takes, and the gate is a column, so it holds for all of it.
    await new Promise(resolve => setTimeout(resolve, 1500))

    await boss.supervise()

    expect(await monitorOn(ctx.schema, 'backoff')).toEqual(claimed)
  })

  it('lets the aggregate run again once the deadline has passed', async function () {
    const boss = await startBoss({ monitorIntervalSeconds: 1 })

    await query(`UPDATE ${ctx.schema}.version SET monitor_backoff_on = now() - interval '1 second'`)

    await boss.supervise()

    expect(await monitorOn(ctx.schema, 'backoff')).not.toBeNull()
  })

  it('serves the cached counts to a forced read while backed off', async function () {
    const boss = await startBoss()

    await boss.send('backoff', {})
    await boss.supervise()

    const [cached] = await boss.getQueueStats('backoff')

    await boss.send('backoff', {})

    await query(`UPDATE ${ctx.schema}.version SET monitor_backoff_on = now() + interval '10 minutes'`)

    // { force: true } runs the same whole-table aggregate the backoff is spacing out, so it has to
    // lose to it. capturedOn is unchanged, which is how the caller can tell.
    const [forced] = await boss.getQueueStats('backoff', { force: true })

    expect(forced.totalCount).toBe(cached.totalCount)
    expect(new Date(forced.capturedOn).getTime()).toBe(new Date(cached.capturedOn).getTime())
  })

  it('does not run when vacuum monitoring is turned off', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 90, monitorVacuum: false })

    await boss.supervise()

    expect(await backoffUntil(ctx.schema)).toBeNull()
    expect(await warnings(ctx.schema)).toHaveLength(0)
  })

  it('stamps the capture time when the counts land, not when the pass claimed them', async function () {
    const boss = await startBoss({ __test__delay_maint_ms: 0 })

    await boss.send('backoff', {})

    const before = new Date()
    await boss.supervise()

    const stamped = await monitorOn(ctx.schema, 'backoff')

    helper.assertTruthy(stamped)

    // cacheQueueStats re-stamps monitor_on in the same statement that writes the counts. Without
    // that the interval is measured start-to-start, and stops delaying anything at all the moment
    // one aggregate outruns it.
    expect(new Date(stamped).getTime()).toBeGreaterThanOrEqual(before.getTime())
  })

  it('never shortens a deadline another instance already set', async function () {
    const boss = await startBoss({ __test__monitor_stats_seconds: 300 })

    await boss.supervise()

    const long = await backoffUntil(ctx.schema)

    helper.assertTruthy(long)

    // A second instance whose own pass was only marginally slow computes a 2-naptime backoff. It
    // must not overwrite the 300s one already in force: instances measure independently, so the
    // deadline may only ever move outward or the shorter write re-opens the window the longer one
    // closed.
    await query(plans.setMonitorBackoff(ctx.schema, 7).text, plans.setMonitorBackoff(ctx.schema, 7).values)

    expect((await backoffUntil(ctx.schema))!.getTime()).toBe(new Date(long).getTime())
  })

  it('still expires timed-out jobs while the aggregate is backed off', async function () {
    const boss = await startBoss({ monitorIntervalSeconds: 1 })

    const jobId = await boss.send('backoff', {}, { expireInSeconds: 1 })

    helper.assertTruthy(jobId)

    await boss.fetch('backoff')

    // The backoff exists to space out the whole-table aggregate. Expiry is a narrow indexed update
    // that pins nothing, so gating it on the horizon would turn a vacuum-safety valve into a
    // job-expiry outage lasting two naptimes at minimum.
    await query(`UPDATE ${ctx.schema}.version SET monitor_backoff_on = now() + interval '10 minutes'`)
    await query(`UPDATE ${ctx.schema}.job SET started_on = now() - interval '1 hour' WHERE id = $1`, [jobId])

    await boss.supervise()

    const job = await boss.getJobById('backoff', jobId)

    expect(job?.state).not.toBe('active')
  })

  // These three need a second, independent connection - one to hold the queue-stats lock or the
  // pool while another instance tries to proceed. PGlite has no server and CockroachDB has no
  // advisory locks, so the scenario cannot be staged on either.
  helper.describeMultiConnectionOnly('under contention', function () {
    it('measures the pin on the server, not the latency of the call', async function () {
      const boss = await startBoss()

      await boss.send('backoff', {})

      // One connection, and something else already holding it. This is the shape a busy app hands the
      // supervisor: the same pool serves every fetch and complete, so the wait for a connection lands
      // inside any stopwatch the client wraps around the call — while pinning nothing, because the
      // transaction has not begun yet. Deferring on that number would blame the job table for pool
      // contention, and deferring monitoring would do nothing to relieve it.
      const pool = new pg.Pool({ connectionString: helper.getConnectionString(), max: 1 })

      try {
        const hog = pool.query('SELECT pg_sleep(2)')

        await new Promise(resolve => setTimeout(resolve, 50))

        const started = Date.now()
        const result = await pool.query(plans.cacheQueueStats(ctx.schema, 'job', ['backoff']))
        const callSeconds = (Date.now() - started) / 1000

        const rows = (Array.isArray(result) ? result : [result]).flatMap(r => r?.rows ?? [])
        const pinSeconds = rows.reduce((max, row) => Math.max(max, Number(row.pinSeconds) || 0), 0)

        expect(callSeconds).toBeGreaterThan(1.5)
        expect(pinSeconds).toBeLessThan(0.5)

        await hog
      } finally {
        await pool.end()
      }
    })

    // The same key cacheQueueStats/refreshQueueStats derive, computed in SQL so the test cannot drift
    // from the implementation's hashing.
    const LOCK_KEY = (schema: string) =>
      `('x' || encode(sha224((current_database() || '.pgboss.${schema}queue-stats')::bytea), 'hex'))::bit(64)::bigint`

    async function holdStatsLock (schema: string) {
      const client = new pg.Client(helper.getConnectionString())
      await client.connect()
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY(schema)})`)

      return async () => {
        await client.query('ROLLBACK')
        await client.end()
      }
    }

    it('skips the aggregate instead of queueing behind another instance', async function () {
      const boss = await startBoss({ monitorIntervalSeconds: 1 })

      await boss.send('backoff', {})
      await boss.supervise()

      const [before] = await boss.getQueueStats('backoff')

      await boss.send('backoff', {})

      const claimBefore = await monitorClaimOn(ctx.schema, 'backoff')

      const release = await holdStatsLock(ctx.schema)

      try {
        await new Promise(resolve => setTimeout(resolve, 1500))

        // Blocking here would hold this backend's snapshot for the whole of the other instance's
        // scan, which is the overlap the backoff exists to prevent. The pass gives up instead.
        const started = Date.now()
        await boss.supervise()
        const seconds = (Date.now() - started) / 1000

        expect(seconds).toBeLessThan(1)

        const [after] = await boss.getQueueStats('backoff')

        // And it gives up without writing counts: an empty stats CTE still LEFT JOINs, so an
        // unguarded UPDATE would COALESCE every one of them to zero.
        expect(after.totalCount).toBe(before.totalCount)

        // capturedOn does NOT move. monitor_on is stamped by the aggregate that writes the counts,
        // and this pass wrote none, so the reported capture time stays honest about how old the
        // counts really are.
        expect(new Date(after.capturedOn).getTime()).toBe(new Date(before.capturedOn).getTime())

        // The claim did move, which is what makes the queue sit out one interval rather than
        // retrying immediately against a lock another instance is still holding.
        const claimAfter = await monitorClaimOn(ctx.schema, 'backoff')
        expect(claimAfter!.getTime()).toBeGreaterThan(claimBefore!.getTime())
      } finally {
        await release()
      }
    })

    it('runs a never-monitored queue\'s first scan even while losing the race', async function () {
      const boss = await startBoss()

      await boss.send('backoff', {})
      await boss.send('backoff', {})

      const release = await holdStatsLock(ctx.schema)

      try {
        // The lock key is global, not per-queue, so any supervise aggregate anywhere in the schema
        // collides with a first read. Losing it would answer with the queue columns' default zeros —
        // a fabricated count, not a stale one, because this queue has no capture to fall back on.
        const [stats] = await boss.getQueueStats('backoff')

        expect(stats.totalCount).toBe(2)
        expect(stats.capturedOn).not.toBeNull()
      } finally {
        await release()
      }
    })

    it('serves the cache when a forced read loses the same race', async function () {
      const boss = await startBoss()

      await boss.send('backoff', {})
      await boss.supervise()

      const [cached] = await boss.getQueueStats('backoff')

      await boss.send('backoff', {})

      const release = await holdStatsLock(ctx.schema)

      try {
        // refreshQueueStats had no gate at all before this: every instance holding a stale cache ran
        // its own whole-table scan, and two different queue names did not even contend.
        const [forced] = await boss.getQueueStats('backoff', { force: true })

        expect(forced.totalCount).toBe(cached.totalCount)
        expect(new Date(forced.capturedOn).getTime()).toBe(new Date(cached.capturedOn).getTime())
      } finally {
        await release()
      }
    })
  })
})
