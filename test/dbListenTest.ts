import { it, expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

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
