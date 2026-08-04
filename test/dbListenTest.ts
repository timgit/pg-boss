import pg from 'pg'
import { it, expect, vi } from 'vitest'
import Db from '../src/db.ts'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import HalfOpenProxy from './halfOpenProxy.ts'

// Exercises the low-level LISTEN/NOTIFY connection lifecycle on Db directly: the
// dedicated session-pinned client, capped-backoff reconnection after a dropped
// connection, and gap recovery via onReconnect. These paths can't be reached
// through the high-level Notifier without killing a real backend, so they're
// driven here against a live Postgres.

async function terminateListener (db: any, channel: string): Promise<void> {
  await db.executeSql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN "${channel}"'`
  )
}

// The built-in Db.listen path is the pg.Pool/pg.Client driver: a dedicated session-pinned client,
// pg_terminate_backend, and capped-backoff reconnection. None of that exists for embedded
// single-connection PGlite, so skip the whole file there (PGlite's listen is covered via fromPglite).
helper.describePglite('db listen/notify', function () {
  it('detects a silent half-open listener and restores the subscription', async function () {
    const config = helper.getConfig()
    if (!config.host || !config.port) throw new Error('Postgres host and port are required')

    const proxy = new HalfOpenProxy(config.host, config.port)
    const proxyPort = await proxy.start()
    const db = new Db({
      ...config,
      application_name: 'pgboss_half_open_test',
      host: '127.0.0.1',
      port: proxyPort,
      notifyHeartbeatIntervalMs: 100,
      notifyHeartbeatTimeoutMs: 100
    })
    const channel = 'pgboss_db_half_open_test'
    const payloads: string[] = []
    const errors: Error[] = []
    let reconnects = 0
    let handle: Awaited<ReturnType<Db['listen']>> | undefined

    db.on('error', error => errors.push(error))
    await db.open()

    try {
      const generation = proxy.listenerGeneration
      handle = await db.listen(channel, payload => payloads.push(payload), () => { reconnects++ })
      const listener = await proxy.waitForListenerAfter(generation)
      expect(reconnects).toBe(1)

      proxy.blackhole(listener)

      for (let i = 0; i < 40; i++) {
        if (reconnects >= 2) break
        await delay(100)
      }

      expect(reconnects).toBe(2)
      expect(errors.some(error => error.message === 'LISTEN/NOTIFY heartbeat timed out')).toBe(true)

      await db.executeSql(`NOTIFY "${channel}", 'recovered'`)
      for (let i = 0; i < 30; i++) {
        if (payloads.length) break
        await delay(100)
      }
      expect(payloads).toContain('recovered')
    } finally {
      await handle?.close()
      await db.close()
      await proxy.close()
    }
  })

  it('reconnects when the heartbeat finds the channel registration missing', async function () {
    const db = new Db({
      ...helper.getConfig(),
      application_name: 'pgboss_lost_subscription_test',
      notifyHeartbeatIntervalMs: 100,
      notifyHeartbeatTimeoutMs: 100
    })
    const channel = 'pgboss_db_lost_subscription_test'
    const payloads: string[] = []
    const errors: Error[] = []
    let reconnects = 0
    let reportMissing = true
    let handle: Awaited<ReturnType<Db['listen']>> | undefined
    const originalQuery = pg.Client.prototype.query
    const querySpy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: any[]) {
      const [text] = args
      if (reportMissing && typeof text === 'string' && text.includes('FROM pg_listening_channels()')) {
        reportMissing = false
        return Promise.resolve({ rows: [{ listening: false }] }) as any
      }

      return originalQuery.apply(this, args as any)
    })

    db.on('error', error => errors.push(error))

    try {
      await db.open()
      handle = await db.listen(channel, payload => payloads.push(payload), () => { reconnects++ })
      expect(reconnects).toBe(1)

      for (let i = 0; i < 30; i++) {
        if (reconnects >= 2) break
        await delay(100)
      }

      expect(reconnects).toBe(2)
      expect(errors.some(error => error.message === 'LISTEN/NOTIFY channel registration was lost')).toBe(true)

      await db.executeSql(`NOTIFY "${channel}", 'recovered'`)
      for (let i = 0; i < 30; i++) {
        if (payloads.length) break
        await delay(100)
      }
      expect(payloads).toContain('recovered')
    } finally {
      querySpy.mockRestore()
      await handle?.close()
      await db.close()
    }
  })

  it('reconnects after the listen connection drops and delivers later notifications', async function () {
    const db = await helper.getDb()
    const channel = 'pgboss_db_reconnect_test'
    const payloads: string[] = []
    let reconnects = 0

    // The administrator-terminate surfaces as an 'error' on the dedicated client.
    db.on('error', () => {})

    const handle = await db.listen(channel, p => payloads.push(p), () => { reconnects++ })

    expect(reconnects).toBe(1)

    await terminateListener(db, channel)

    // First backoff is ~1s; wait for the self-contained reconnect to re-LISTEN.
    for (let i = 0; i < 60; i++) {
      if (reconnects >= 2) break
      await delay(100)
    }
    expect(reconnects).toBe(2)

    // A NOTIFY on the recovered session is delivered to the handler.
    await db.executeSql(`NOTIFY "${channel}", 'hello'`)
    for (let i = 0; i < 30; i++) {
      if (payloads.length) break
      await delay(100)
    }
    expect(payloads).toContain('hello')

    await handle.close()
    await db.close()
  })

  it('cancels a pending reconnect when closed during backoff', async function () {
    const db = await helper.getDb()
    const channel = 'pgboss_db_close_during_backoff'
    let reconnects = 0

    db.on('error', () => {})

    const handle = await db.listen(channel, () => {}, () => { reconnects++ })
    expect(reconnects).toBe(1)

    await terminateListener(db, channel)

    // Let the error handler schedule the reconnect timer, then close mid-backoff.
    await delay(150)
    await handle.close()

    const before = reconnects
    await delay(1500)
    expect(reconnects).toBe(before)

    await db.close()
  })

  it('tears down the connection and rejects when the LISTEN fails after connecting', async function () {
    const db = await helper.getDb()
    db.on('error', () => {})

    // A channel name with an embedded double quote leaves connect() to succeed but breaks the
    // quoted identifier, so the LISTEN query rejects. The listener must end the half-open
    // client (no leaked connection) and propagate the error rather than resolve a handle.
    await expect(
      db.listen('bad"channel', () => {}, () => {})
    ).rejects.toThrow()

    await db.close()
  })

  it('rolls back the transaction when the callback throws and commits otherwise', async function () {
    const db = await helper.getDb()

    await expect(
      db.withTransaction(async () => { throw new Error('rollback me') })
    ).rejects.toThrow('rollback me')

    const result = await db.withTransaction(async (tx) => {
      const { rows } = await tx.executeSql('select 1 as one')
      return rows[0].one
    })
    expect(parseInt(result, 10)).toBe(1)

    await db.close()
  })

  it('close is idempotent', async function () {
    const db = await helper.getDb()
    await db.close()
    await db.close()
  })
})
