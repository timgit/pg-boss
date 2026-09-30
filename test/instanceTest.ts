import os from 'node:os'
import { it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import packageJson from '../package.json' with { type: 'json' }
import type { Instance } from '../src/types.ts'
import * as plans from '../src/plans.ts'

async function instances (boss: PgBoss): Promise<Instance[]> {
  return await boss.getInstances()
}

async function only (boss: PgBoss): Promise<Instance> {
  const rows = await instances(boss)
  expect(rows).toHaveLength(1)
  return rows[0]
}

async function sql (text: string, values?: unknown[]) {
  const db = await helper.getDb()
  try {
    return await db.executeSql(text, values)
  } finally {
    await db.close()
  }
}

describe('instance registry', function () {
  it('registers at start() with who it is and what it does', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'billing-worker', supervise: false, schedule: false, persistQueueStats: true, persistWarnings: false })

    const row = await only(ctx.boss)

    expect(row.name).toBe('billing-worker')
    expect(row.host).toBe(os.hostname())
    expect(row.pid).toBe(process.pid)
    expect(row.version).toBe(packageJson.version)
    expect(row.nodeVersion).toBe(process.version)
    expect(row.heartbeatSeconds).toBe(30)
    expect(row.supervise).toBe(false)
    expect(row.schedule).toBe(false)
    expect(row.migrate).toBe(true)
    expect(row.persistQueueStats).toBe(true)
    expect(row.persistWarnings).toBe(false)
    expect(row.workers).toEqual([])
    expect(row.stoppedOn).toBeNull()
    expect(row.live).toBe(true)
    expect(row.startedOn).toBeInstanceOf(Date)
    // Rates need two samples, so the first carries limits and memory but no CPU yet.
    expect(row.metrics?.cpu).toBeNull()
    expect(row.metrics?.cpuLimit).toBeGreaterThan(0)
    expect(row.metrics?.memoryLimit).toBeGreaterThan(0)
    expect(row.metrics?.rss).toBeGreaterThan(0)

    if (helper.isPglite) {
      // A caller-supplied adapter: pg-boss neither names its connections nor can count its pool.
      expect(row.poolMax).toBeNull()
    } else {
      expect(row.applicationName).toMatch(/^pgboss:[0-9a-f]{8}$/)
      expect(row.applicationName).toBe(`pgboss:${row.id.slice(0, 8)}`)
      expect(row.poolMax).toBe(ctx.bossConfig.max ?? 10)
      expect(row.poolTotal).toBeGreaterThanOrEqual(1)
    }
  })

  helper.itPostgresOnly('names the pool connections after the instance, so pg_stat_activity joins to the row', async function () {
    if (helper.isPglite) return

    ctx.boss = await helper.start({ ...ctx.bossConfig })

    const row = await only(ctx.boss)
    const { rows } = await sql('SELECT count(*)::int as n FROM pg_stat_activity WHERE application_name = $1', [row.applicationName])

    expect(rows[0].n).toBeGreaterThanOrEqual(1)
  })

  it('keeps a name the caller gave the connections', async function () {
    if (helper.isPglite) return

    ctx.boss = await helper.start({ ...ctx.bossConfig, application_name: 'billing' })

    expect((await only(ctx.boss)).applicationName).toBe('billing')
  })

  it('records each work() call on the heartbeat, its workers folded into one entry', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceHeartbeatSeconds: 1 })

    const first = await only(ctx.boss)

    await ctx.boss.work(ctx.schema, { localConcurrency: 2, batchSize: 3, pollingIntervalSeconds: 0.5, includeMetadata: true, maxPriority: 5 }, async () => {})
    await ctx.boss.send(ctx.schema)

    await helper.until(async () => {
      const row = await only(ctx.boss!)
      return row.workers.length === 1 && row.workers[0].lastJobEndedOn !== null
    }, 10_000)

    const row = await only(ctx.boss)
    const [worker] = row.workers

    expect(worker.queue).toBe(ctx.schema)
    expect(worker.localConcurrency).toBe(2)
    expect(worker.batchSize).toBe(3)
    expect(worker.pollingIntervalSeconds).toBe(0.5)
    expect(worker.active).toBe(0)
    expect(worker.options).toEqual({ includeMetadata: true, maxPriority: 5 })
    expect(Date.parse(worker.lastFetchedOn!)).not.toBeNaN()
    expect(row.heartbeatOn.getTime()).toBeGreaterThan(first.heartbeatOn.getTime())
    expect(row.startedOn.getTime()).toBe(first.startedOn.getTime())
    expect(JSON.stringify(row.workers)).not.toContain('lastError"')
  })

  it('marks a stopped instance stopped, and a restart live again under the same id', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })
    const { id } = await only(ctx.boss)

    await ctx.boss.stop({ close: false })

    const stopped = await only(ctx.boss)
    expect(stopped.id).toBe(id)
    expect(stopped.stoppedOn).toBeInstanceOf(Date)
    expect(stopped.live).toBe(false)

    await ctx.boss.start()

    const restarted = await only(ctx.boss)
    expect(restarted.id).toBe(id)
    expect(restarted.stoppedOn).toBeNull()
    expect(restarted.live).toBe(true)
  })

  it('reads as quiet once three heartbeats are missed', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceHeartbeatSeconds: 60 })
    const { id } = await only(ctx.boss)

    await sql(`UPDATE ${ctx.schema}.instance SET heartbeat_on = heartbeat_on - interval '179 seconds' WHERE id = $1`, [id])
    expect((await only(ctx.boss)).live).toBe(true)

    await sql(`UPDATE ${ctx.schema}.instance SET heartbeat_on = heartbeat_on - interval '2 seconds' WHERE id = $1`, [id])
    expect((await only(ctx.boss)).live).toBe(false)
  })

  it('puts a missing row back on the next heartbeat, with the start it registered', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceHeartbeatSeconds: 1 })
    const registered = await only(ctx.boss)

    await sql(`DELETE FROM ${ctx.schema}.instance`)

    await helper.until(async () => (await instances(ctx.boss!)).length === 1, 5_000)

    const row = await only(ctx.boss)
    expect(row.id).toBe(registered.id)
    expect(row.startedOn.getTime()).toBe(registered.startedOn.getTime())
  })

  it('does not register with registerInstance off, and leaves the connections their default name', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false })

    expect(await instances(ctx.boss)).toEqual([])

    if (!helper.isPglite) {
      const { rows } = await ctx.boss.getDb().executeSql("SELECT current_setting('application_name') as name")
      expect(rows[0].name).toBe('pgboss')
    }
  })

  it('maintenance deletes rows quiet for more than seven days, whatever this instance registers', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })

    const stale = { id: '00000000-0000-4000-8000-000000000001', days: 8 }
    const recent = { id: '00000000-0000-4000-8000-000000000002', days: 6 }

    for (const r of [stale, recent]) {
      await sql(`
        INSERT INTO ${ctx.schema}.instance (id, host, pid, version, node_version, heartbeat_seconds,
          supervise, schedule, migrate, persist_queue_stats, persist_warnings, started_on, heartbeat_on, stopped_on)
        VALUES ($1, 'gone', 1, '12.0.0', 'v22.0.0', 30, true, true, true, false, false,
          now() - $2::int * interval '1 day', now() - $2::int * interval '1 day', NULL)
      `, [r.id, r.days])
    }

    await ctx.boss.supervise()

    const ids = (await instances(ctx.boss)).map(i => i.id)
    expect(ids).toEqual([recent.id])
  })

  // Rows for other lives, n of them, started a minute apart ending `newestMinutesAgo` ago. Quiet unless
  // `stopped`, or live when heard from a second ago.
  async function lives (opts: { n: number, name: string | null, host: string, newestMinutesAgo?: number, state?: 'quiet' | 'stopped' | 'live', from?: number }) {
    const { n, name, host, newestMinutesAgo = 10, state = 'quiet', from = 0 } = opts
    await sql(`
      INSERT INTO ${ctx.schema}.instance (id, name, host, pid, version, node_version, heartbeat_seconds,
        supervise, schedule, migrate, persist_queue_stats, persist_warnings, started_on, heartbeat_on, stopped_on)
      SELECT gen_random_uuid(), $1, $2, 1000 + i, '12.36.0', 'v22.0.0', 30, false, false, false, false, false,
        now() - (i + $3::int) * interval '1 minute',
        CASE WHEN $4 = 'live' THEN now() - interval '1 second' ELSE now() - (i + $3::int) * interval '1 minute' + interval '30 seconds' END,
        CASE WHEN $4 = 'stopped' THEN now() - (i + $3::int) * interval '1 minute' + interval '30 seconds' END
      FROM generate_series($5::int, $5::int + $6::int - 1) i
    `, [name, host, newestMinutesAgo, state, from, n])
  }

  async function countWhere (where: string, values: unknown[] = []) {
    const { rows } = await sql(`SELECT count(*)::int as n FROM ${ctx.schema}.instance WHERE ${where}`, values)
    // CockroachDB returns its INT8 counts as strings.
    return Number(rows[0].n)
  }

  it('registering keeps the newest 20 dead rows for its name, and leaves live rows and other names alone', async function () {
    const kept = plans.INSTANCE_DEAD_KEPT_PER_NAME
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })

    await lives({ n: kept + 5, name: 'billing-worker', host: 'jobs-03' })
    await lives({ n: 1, name: 'billing-worker', host: 'jobs-03', state: 'stopped', from: kept + 5 })
    await lives({ n: 2, name: 'billing-worker', host: 'jobs-04', state: 'live' })
    await lives({ n: 3, name: 'other', host: 'jobs-03' })
    const newest = await countWhere("name = 'billing-worker' AND started_on > now() - $1::int * interval '1 minute'", [10 + kept])
    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'billing-worker', supervise: false })

    expect(await countWhere("name = 'billing-worker' AND pid >= 1000 AND host = 'jobs-03'")).toBe(kept)
    // The ones kept are the newest: every dead row that started within the kept window is still there.
    expect(await countWhere("name = 'billing-worker' AND started_on > now() - $1::int * interval '1 minute'", [10 + kept])).toBe(newest + 1)
    expect(await countWhere("name = 'billing-worker' AND host = 'jobs-04'")).toBe(2)
    expect(await countWhere("name = 'other'")).toBe(3)
    expect((await instances(ctx.boss)).filter(i => i.live && i.name === 'billing-worker')).toHaveLength(3)
  })

  it('an unnamed instance keeps the newest dead rows for its host', async function () {
    const kept = plans.INSTANCE_DEAD_KEPT_PER_NAME
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })

    await lives({ n: kept + 2, name: null, host: os.hostname() })
    await lives({ n: kept + 2, name: null, host: 'elsewhere' })
    await lives({ n: kept + 2, name: 'named', host: os.hostname() })
    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })

    const self = (await instances(ctx.boss)).find(i => i.live)!
    expect(await countWhere('name IS NULL AND host = $1 AND id <> $2', [os.hostname(), self.id])).toBe(kept)
    expect(await countWhere("name IS NULL AND host = 'elsewhere'")).toBe(kept + 2)
    expect(await countWhere("name = 'named'")).toBe(kept + 2)
  })

  it('maintenance keeps the newest dead rows in all, however many names left them', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })

    for (let k = 0; k < 5; k++) {
      await lives({ n: 1, name: `replica-${k}`, host: 'old', newestMinutesAgo: 5000 })
    }
    await sql(`
      INSERT INTO ${ctx.schema}.instance (id, name, host, pid, version, node_version, heartbeat_seconds,
        supervise, schedule, migrate, persist_queue_stats, persist_warnings, started_on, heartbeat_on, stopped_on)
      SELECT gen_random_uuid(), 'pod-' || i, 'pod-' || i, 1, '12.36.0', 'v22.0.0', 30, false, false, false, false, false,
        now() - i * interval '1 second' - interval '1 hour', now() - i * interval '1 second' - interval '1 hour', NULL
      FROM generate_series(1, $1::int) i
    `, [plans.INSTANCE_DEAD_KEPT])
    await lives({ n: 1, name: 'api', host: 'app-01', state: 'live', newestMinutesAgo: 9000 })

    await ctx.boss.supervise()

    expect(await countWhere('true')).toBe(plans.INSTANCE_DEAD_KEPT + 1)
    expect(await countWhere("host = 'old'")).toBe(0)
    expect(await countWhere("name = 'api'")).toBe(1)
  })

  // One earlier life on this host: started and last heard from `startedAgo` and `beatAgo` seconds ago.
  async function life (opts: { name: string, startedAgo: number, beatAgo: number, stopped?: boolean, pid?: number, heartbeatSeconds?: number }) {
    const { name, startedAgo, beatAgo, stopped = false, pid = 1, heartbeatSeconds = 30 } = opts
    await sql(`
      INSERT INTO ${ctx.schema}.instance (id, name, host, pid, version, node_version, heartbeat_seconds,
        supervise, schedule, migrate, persist_queue_stats, persist_warnings, started_on, heartbeat_on, stopped_on)
      VALUES (gen_random_uuid(), $1, $2, $3, '12.36.0', 'v22.0.0', $4, false, false, false, false, false,
        now() - $5::float * interval '1 second', now() - $6::float * interval '1 second',
        CASE WHEN $7::bool THEN now() - $6::float * interval '1 second' END)
    `, [name, os.hostname(), pid, heartbeatSeconds, startedAgo, beatAgo, stopped])
  }

  // The newest life with this name: the one this test started.
  async function mine (name: string) {
    return (await instances(ctx.boss!)).filter(i => i.name === name && !i.stoppedOn)
      .sort((a, b) => b.startedOn.getTime() - a.startedOn.getTime())[0]
  }

  it('counts the lives that crashed in a row before this one, back to the last clean stop', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })
    await life({ name: 'billing-worker', startedAgo: 3600, beatAgo: 3000 })
    await life({ name: 'billing-worker', startedAgo: 2400, beatAgo: 1800, stopped: true })
    for (const ago of [1500, 900, 300]) {
      await life({ name: 'billing-worker', startedAgo: ago + 300, beatAgo: ago })
    }
    await life({ name: 'other', startedAgo: 200, beatAgo: 100 })
    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'billing-worker', supervise: false })

    const row = await mine('billing-worker')
    expect(row.crashRestarts).toBe(3)
    expect(Date.now() - row.crashRestartsSince!.getTime()).toBeGreaterThan(1400 * 1000)
    expect(Date.now() - row.crashRestartsSince!.getTime()).toBeLessThan(1600 * 1000)

    // Each crashed life carries the count before it, so the earliest kept row can stand for pruned ones.
    const counts = (await instances(ctx.boss)).filter(i => i.name === 'billing-worker' && !i.live && !i.stoppedOn)
      .sort((a, b) => a.startedOn.getTime() - b.startedOn.getTime()).map(i => i.crashRestarts)
    expect(counts).toEqual([0, 0, 1, 2])
  })

  it('counts a life that crashed moments ago once it would have gone quiet', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })
    await life({ name: 'fast-loop', startedAgo: 60, beatAgo: 0.5, heartbeatSeconds: 1 })
    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'fast-loop', supervise: false })
    expect((await mine('fast-loop')).crashRestarts).toBe(0)

    await helper.until(async () => (await mine('fast-loop')).crashRestarts === 1, 10_000)
  })

  it('does not count a sibling process that keeps beating', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })
    await life({ name: 'cluster', startedAgo: 60, beatAgo: 0.5, heartbeatSeconds: 1, pid: 4242 })
    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'cluster', supervise: false })

    // Past the moment it would have gone quiet, and the recount that follows.
    const until = Date.now() + 6000
    while (Date.now() < until) {
      await sql(`UPDATE ${ctx.schema}.instance SET heartbeat_on = now() WHERE pid = 4242`)
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    expect((await mine('cluster')).crashRestarts).toBe(0)
  })

  it('counts an earlier process that reused this pid at once, as a container restart does', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })
    const uptime = process.uptime()
    await life({ name: 'pid-one', startedAgo: uptime + 600, beatAgo: uptime + 5, pid: process.pid })
    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'pid-one', supervise: false })

    expect((await mine('pid-one')).crashRestarts).toBe(1)
  })

  it('keeps counting past the rows the pruning removes', async function () {
    const kept = plans.INSTANCE_DEAD_KEPT_PER_NAME
    ctx.boss = await helper.start({ ...ctx.bossConfig, registerInstance: false, supervise: false })
    for (let k = kept + 5; k >= 1; k--) {
      await life({ name: 'looping', startedAgo: k * 600 + 300, beatAgo: k * 600 })
    }
    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'looping', supervise: false })
    const first = await mine('looping')
    expect(first.crashRestarts).toBe(kept + 5)

    // It crashes too: no stop(), and quiet by now.
    await ctx.boss.stop({ graceful: false })
    await sql(`UPDATE ${ctx.schema}.instance SET stopped_on = NULL, heartbeat_on = now() - interval '5 minutes', started_on = now() - interval '6 minutes' WHERE id = $1`, [first.id])

    ctx.boss = await helper.start({ ...ctx.bossConfig, instanceName: 'looping', supervise: false })
    expect((await mine('looping')).crashRestarts).toBe(kept + 6)
    expect(await countWhere("name = 'looping' AND stopped_on IS NULL")).toBe(kept + 1)
  })

  it('records the options it runs with, and nothing that connects to the database', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, monitorIntervalSeconds: 45, warningQueueSize: 500 })

    const { config } = (await instances(ctx.boss)).find(i => i.live)!

    expect(config.supervise).toBe(false)
    expect(config.monitorIntervalSeconds).toBe(45)
    expect(config.warningQueueSize).toBe(500)
    expect(config.adapter).toBe(helper.isPglite ? 'custom' : 'pg')

    for (const key of ['password', 'connectionString', 'user', 'host', 'database', 'port', 'ssl', 'options', 'db', 'clock', 'application_name']) {
      expect(config).not.toHaveProperty(key)
    }
  })

  it('refuses a heartbeat interval outside 1 to 3600 seconds, and an empty name', function () {
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceHeartbeatSeconds: 0 })).toThrow('instanceHeartbeatSeconds')
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceHeartbeatSeconds: 3601 })).toThrow('instanceHeartbeatSeconds')
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceHeartbeatSeconds: 1.5 })).toThrow('instanceHeartbeatSeconds')
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceName: '' })).toThrow('instanceName')
  })
})
