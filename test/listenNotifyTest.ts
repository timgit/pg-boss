import { describe, it, expect } from 'vitest'
import { SQL } from 'bun'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as plans from '../src/plans.ts'
import { delay } from '../src/tools.ts'
import { BunBoss, fromBunSql } from '../src/index.ts'

// Subscribes on this schema's bun-boss channel via the shared PGlite instance and collects
// payloads. Returns the collected array plus a close function. Under DB_TYPE=pglite the boss
// produces into the same instance, so this asserts the producer's NOTIFY emission directly,
// without timing-dependent worker assertions.
async function rawListener (schema: string) {
  const pglite = helper.getPgliteInstance()
  const received: string[] = []
  // Resolve the channel literal from the same SQL expression the producer uses.
  const { rows } = await pglite.query<{ channel: string }>(`SELECT ${plans.notifyChannelSql(schema)} AS channel`)
  const unsubscribe = await pglite.listen(rows[0].channel, payload => { if (payload) received.push(payload) })
  return { received, close: () => unsubscribe() }
}

helper.describeListenNotify('listen/notify', function () {
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
      // and the future job must not contribute an extra notification. insert() also defaults
      // returnId to false, so this exercises the wrapper's `< 0` branch where the outer SELECT
      // returns no rows — proving pg_notify still fires independent of the returned row set.
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

  it('uses the relaxed notify polling interval (not the fallback) while notify is active', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, useListenNotify: true, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    let processed = false
    // Short fallback, long notify backstop. While notify is active the worker must poll on the
    // long backstop, so a poll-only job (no NOTIFY) must NOT be picked up by the short fallback.
    await ctx.boss.work(queue, { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 30 }, async () => { processed = true })

    await delay(250)

    // A future-dated job does not fire NOTIFY (gated on start_after <= now()), so it can only be
    // found by polling. On the 0.5s fallback it would be picked up fast; on the 30s notify
    // backstop it stays waiting.
    await ctx.boss.send(queue, {}, { startAfter: 1 })

    await delay(2000)
    expect(processed).toBe(false)
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
})

// The built-in driver (Bun's SQL client) implements no LISTEN, so a listener can never be
// established on these backends: useListenNotify degrades to polling with a warning. Runs on the
// real-server modes (default and no-skip-locked-no-cte), where the fromBunSql shape below talks to
// the same Postgres the boss does.
helper.describePglite('listen/notify fallback (no listener capability)', function () {
  it('uses the fallback poll interval when notify is desired but the listener is unavailable', async function () {
    const config = helper.getConfig({ schema: ctx.schema })

    // Bare adapter: no `listen` capability, so the listener can't be established and notify is
    // unavailable even though the queue opts in. The worker must use the fast fallback, not the
    // long notify backstop.
    const sql = new SQL(helper.getConnectionString(), { max: 5 })
    const adapter = fromBunSql(sql)

    const boss = new BunBoss({ ...config, db: adapter, useListenNotify: true })
    boss.on('warning', () => {})
    boss.on('error', () => {})

    await boss.start()

    try {
      const queue = ctx.schema
      await boss.createQueue(queue, { notify: true })

      let processedAt = 0
      await boss.work(queue, { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 30 }, async () => { processedAt = Date.now() })

      await delay(250)
      const sentAt = Date.now()
      await boss.send(queue)

      for (let i = 0; i < 30; i++) {
        if (processedAt) break
        await delay(100)
      }

      expect(processedAt).toBeGreaterThan(0)
      // Picked up on the 0.5s fallback, well before the 30s notify backstop would fire.
      expect(processedAt - sentAt).toBeLessThan(3000)
    } finally {
      await boss.stop({ timeout: 2000 })
      await sql.close()
    }
  })

  it('warns and continues polling when the database connection cannot LISTEN', async function () {
    const config = helper.getConfig({ schema: ctx.schema })

    // A bare adapter exposes only executeSql (no `listen` capability), like a user-supplied
    // transaction-pooled connection that can't hold a session for LISTEN/NOTIFY.
    const sql = new SQL(helper.getConnectionString(), { max: 5 })
    const adapter = fromBunSql(sql)

    const boss = new BunBoss({ ...config, db: adapter, useListenNotify: true })
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
      await sql.close()
    }
  })

  it('warns and continues polling when the built-in driver is asked for notify', async function () {
    // No db adapter: the built-in driver (Bun's SQL client) implements no LISTEN, so opting into
    // useListenNotify must warn and still deliver via polling.
    const config = helper.getConfig({ schema: ctx.schema })

    const boss = new BunBoss({ ...config, useListenNotify: true })
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
    }
  })
})

// Runs on every backend, including those that don't implement LISTEN/NOTIFY (SQLite sets
// noListenNotify). The producer inlines pg_notify into the insert when a queue opts into
// notify; on a noListenNotify backend that would error, so the producer must suppress it. These
// tests prove the suppression: producing to a notify-enabled queue must never throw and jobs must
// still be delivered by polling.
describe('notify producer bypass (all backends)', function () {
  it('send/insert/flow to a notify-enabled queue succeed and deliver via polling', async function () {
    // supervise:true runs the background resolver so the flow child unblocks once its parent
    // completes (unblocking moved off the completion hot path — issue #824).
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: true, flowIntervalSeconds: 1, __test__bypass_flow_interval_check: true })
    const boss = ctx.boss
    const queue = ctx.schema
    await boss.createQueue(queue, { notify: true })

    const sendId = await boss.send(queue)
    expect(sendId).toBeTruthy()

    const insertIds = await boss.insert(queue, [{ data: { n: 1 } }], { returnId: true })
    expect(insertIds).toHaveLength(1)

    // A parent + dependent child on the notify-enabled queue exercises flow's notifyQueue path.
    await boss.flow([
      { ref: 'parent', name: queue, data: { n: 2 } },
      { ref: 'child', name: queue, data: { n: 3 }, dependsOn: ['parent'] }
    ])

    let processed = 0
    await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async () => { processed++ })

    // send + insert + flow(parent, child) = 4 jobs; the child unblocks once the parent completes
    // and the background resolver runs.
    for (let i = 0; i < 60; i++) {
      if (processed >= 4) break
      await delay(100)
    }
    expect(processed).toBe(4)
  })
})

helper.describeListenNotify('listen/notify update', function () {
  it('update that pulls a future-dated job forward emits a NOTIFY', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    // future-dated => no NOTIFY at send time
    const id = await ctx.boss.send(queue, {}, { startAfter: 60 })

    const listener = await rawListener(ctx.schema)

    try {
      await ctx.boss.update(queue, { v: 2 }, { id: id!, startAfter: new Date(Date.now() - 1000).toISOString() })
      await delay(500)
      expect(listener.received).toContain(queue)
    } finally {
      await listener.close()
    }
  })

  it('partial update that keeps the job future-dated emits no NOTIFY', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    const id = await ctx.boss.send(queue, {}, { startAfter: 60 })

    const listener = await rawListener(ctx.schema)

    try {
      // edits only the payload; start_after stays in the future
      await ctx.boss.update(queue, { v: 2 }, { id: id! })
      await delay(500)
      expect(listener.received).toHaveLength(0)
    } finally {
      await listener.close()
    }
  })

  it('update on a non-notify queue emits no NOTIFY', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: false })

    const id = await ctx.boss.send(queue, {}, { startAfter: 60 })

    const listener = await rawListener(ctx.schema)

    try {
      await ctx.boss.update(queue, { v: 2 }, { id: id!, startAfter: new Date(Date.now() - 1000).toISOString() })
      await delay(500)
      expect(listener.received).toHaveLength(0)
    } finally {
      await listener.close()
    }
  })
})
