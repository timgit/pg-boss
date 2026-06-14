import { describe, it, expect } from 'vitest'
import pg from 'pg'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as plans from '../src/plans.ts'
import { delay } from '../src/tools.ts'
import { PgBoss } from '../src/index.ts'

// Opens a raw pg connection LISTENing on this schema's pg-boss channel and collects
// payloads. Returns the collected array plus a close function. Used to assert the
// producer's NOTIFY emission directly, without timing-dependent worker assertions.
async function rawListener (schema: string) {
  const config = helper.getConfig()
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  })
  await client.connect()
  const received: string[] = []
  client.on('notification', msg => { if (msg.payload) received.push(msg.payload) })
  // Resolve the channel literal from the same SQL expression the producer uses.
  const { rows } = await client.query(`SELECT ${plans.notifyChannelSql(schema)} AS channel`)
  await client.query(`LISTEN "${rows[0].channel}"`)
  return { received, close: () => client.end() }
}

describe('listen/notify', function () {
  it('emits a NOTIFY carrying the queue name for an immediate job on a notify-enabled queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    const listener = await rawListener(ctx.schema)

    try {
      await ctx.boss.send(queue)
      await delay(500)
      expect(listener.received).toContain(queue)
    } finally {
      await listener.close()
    }
  })

  it('does not emit a NOTIFY for a future-dated job (gated on start_after <= now)', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    const listener = await rawListener(ctx.schema)

    try {
      await ctx.boss.send(queue, {}, { startAfter: 60 })
      await delay(500)
      expect(listener.received).toHaveLength(0)
    } finally {
      await listener.close()
    }
  })

  it('does not emit a NOTIFY when the queue is not notify-enabled', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: false })

    const listener = await rawListener(ctx.schema)

    try {
      await ctx.boss.send(queue)
      await delay(500)
      expect(listener.received).toHaveLength(0)
    } finally {
      await listener.close()
    }
  })

  it('updateQueue can toggle notify on', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: false })
    await ctx.boss.updateQueue(queue, { notify: true })

    const listener = await rawListener(ctx.schema)

    try {
      await ctx.boss.send(queue)
      await delay(500)
      expect(listener.received).toContain(queue)
    } finally {
      await listener.close()
    }
  })

  it('fires a single NOTIFY for an insert() batch, gated on immediate availability', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    const listener = await rawListener(ctx.schema)

    try {
      // Two immediate jobs + one future job: exactly one NOTIFY should fire (single-fire),
      // and the future job must not contribute an extra notification.
      await ctx.boss.insert(queue, [
        { data: { n: 1 } },
        { data: { n: 2 } },
        { data: { n: 3 }, startAfter: new Date(Date.now() + 60_000).toISOString() }
      ])
      await delay(500)
      expect(listener.received).toEqual([queue])
    } finally {
      await listener.close()
    }
  })

  it('wakes a worker via NOTIFY well before the polling interval elapses', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, useListenNotify: true, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    let processedAt = 0
    // A long poll interval means anything processed quickly must have come from NOTIFY.
    await ctx.boss.work(queue, { pollingIntervalSeconds: 30 }, async () => { processedAt = Date.now() })

    // Let the worker finish its initial fetch and settle into the poll delay.
    await delay(250)

    const sentAt = Date.now()
    await ctx.boss.send(queue)

    for (let i = 0; i < 30; i++) {
      if (processedAt) break
      await delay(100)
    }

    expect(processedAt).toBeGreaterThan(0)
    expect(processedAt - sentAt).toBeLessThan(3000)
  })

  it('falls back to the poll interval when a queue is not notify-enabled', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, useListenNotify: true, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: false })

    let processed = false
    await ctx.boss.work(queue, { pollingIntervalSeconds: 4 }, async () => { processed = true })

    await delay(250)
    await ctx.boss.send(queue)

    // Without NOTIFY the job should still be waiting on the 4s poll at this point.
    await delay(1500)
    expect(processed).toBe(false)
  })

  it('wakes notify-enabled workers and recovers after the listener reconnects', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, useListenNotify: true, noDefault: true })
    const boss = ctx.boss
    // Terminating the listen backend surfaces as an 'error' on the promoted db events.
    boss.on('error', () => {})
    const notifyQueue = `${ctx.schema}_notify`
    const plainQueue = `${ctx.schema}_plain`

    await boss.createQueue(notifyQueue, { notify: true })
    await boss.createQueue(plainQueue, { notify: false })

    let notifyProcessed = 0
    // A long poll proves wake-ups come from NOTIFY / gap-recovery, not polling.
    await boss.work(notifyQueue, { pollingIntervalSeconds: 30 }, async () => { notifyProcessed++ })
    // A second worker on a non-notify queue exercises the name/notify mismatch
    // branches in notifyQueue() and forceFetchLnWorkers().
    await boss.work(plainQueue, { pollingIntervalSeconds: 30 }, async () => {})

    await delay(300)

    // A notify-gated send wakes only the matching worker (notifyQueue iterates all
    // workers, skipping the plain-queue one).
    await boss.send(notifyQueue)
    for (let i = 0; i < 30; i++) {
      if (notifyProcessed >= 1) break
      await delay(100)
    }
    expect(notifyProcessed).toBe(1)

    // Drop the dedicated listen backend. On reconnect, forceFetchLnWorkers() forces
    // a fetch for notify-enabled workers (and skips the plain one) to recover any
    // notifications missed during the outage.
    const killer = await helper.getDb()
    try {
      await killer.executeSql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN %'")
    } finally {
      await killer.close()
    }

    // After recovery a fresh notify-gated send is delivered again.
    await delay(1500)
    await boss.send(notifyQueue)
    for (let i = 0; i < 40; i++) {
      if (notifyProcessed >= 2) break
      await delay(100)
    }
    expect(notifyProcessed).toBe(2)
  })

  it('warns and continues polling when the database connection cannot LISTEN', async function () {
    const config = helper.getConfig({ schema: ctx.schema })

    // A bare adapter exposes only executeSql (no `listen` capability), like a user-supplied
    // transaction-pooled connection that can't hold a session for LISTEN/NOTIFY.
    const pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password
    })
    const adapter = { executeSql: (text: string, values?: unknown[]) => pool.query(text, values) }

    const boss = new PgBoss({ ...config, db: adapter, useListenNotify: true })
    const warnings: any[] = []
    boss.on('warning', w => warnings.push(w))
    boss.on('error', () => {})

    await boss.start()

    try {
      const queue = ctx.schema
      await boss.createQueue(queue, { notify: true })

      const completed = new Promise<boolean>(resolve => {
        boss.work(queue, { pollingIntervalSeconds: 0.5 }, async () => resolve(true))
      })

      await boss.send(queue)

      expect(await completed).toBe(true)
      expect(warnings.some(w => w?.data?.type === 'listen_notify_unavailable')).toBe(true)
    } finally {
      await boss.stop({ timeout: 2000 })
      await pool.end()
    }
  })
})
