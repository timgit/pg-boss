import os from 'node:os'
import { it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import packageJson from '../package.json' with { type: 'json' }
import type { Instance } from '../src/types.ts'

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

    await ctx.boss.work(ctx.schema, { localConcurrency: 2, batchSize: 3, pollingIntervalSeconds: 0.5 }, async () => {})
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

  it('refuses a heartbeat interval outside 1 to 3600 seconds, and an empty name', function () {
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceHeartbeatSeconds: 0 })).toThrow('instanceHeartbeatSeconds')
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceHeartbeatSeconds: 3601 })).toThrow('instanceHeartbeatSeconds')
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceHeartbeatSeconds: 1.5 })).toThrow('instanceHeartbeatSeconds')
    expect(() => new PgBoss({ ...ctx.bossConfig, instanceName: '' })).toThrow('instanceName')
  })
})
