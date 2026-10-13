import type { IDatabase, TransactionHandle } from '../types.ts'
import { TRANSACTION_ROLLBACK_TIMEOUT_MS } from '../db.ts'
import { delay } from '../tools.ts'
import { fromUnsafeSql } from './unsafeSql.ts'

// Minimal structural type for a postgres.js client (3.4 or later, which added `reserve`) or a
// `sql.begin()` transaction, so pg-boss does not take a hard dependency on the package. postgres.js
// refuses a raw BEGIN with UNSAFE_TRANSACTION unless the connection is reserved or the pool has
// `max: 1`. A transaction has no `reserve`, `listen` or `begin`, and is only ever a per-call `db`.
export interface PostgresJsLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  reserve?(): Promise<PostgresJsReservedLike>
  listen?(
    channel: string,
    onNotification: (payload: string) => void,
    onListen?: () => void
  ): Promise<{ unlisten(): Promise<void> }>
  begin?<T>(fn: (tx: PostgresJsLike) => T | Promise<T>): Promise<unknown>
}

export interface PostgresJsReservedLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  release(): void
}

/**
 * Adapts a postgres.js client to pg-boss's IDatabase, as the constructor `db` or, given a
 * `sql.begin()` transaction, as a per-call `db`. pg-boss never calls `end()` on the client.
 *
 * @see https://pgboss.io/database-backends#postgres-js-driver
 */
export function fromPostgresJs (client: PostgresJsLike): IDatabase {
  // postgres.js encodes array parameters and puts the SQLSTATE in `code` itself, so it needs none of
  // the rewriting Bun does.
  const db = fromUnsafeSql(client, { expandArrays: false })

  if (typeof client.begin === 'function') {
    db.beginTransaction = () => beginTransaction(client)
  }

  return db
}

// A transactional worker settles its transaction from a different call frame than the one that
// opened it, and sql.begin() wants a callback that does both. The callback here parks on a promise
// that commit() resolves and rollback() rejects, which leaves BEGIN, COMMIT, ROLLBACK and a dropped
// connection to postgres.js: the connection goes back to the pool only once the transaction is over.
async function beginTransaction (client: PostgresJsLike): Promise<TransactionHandle> {
  const opened = Promise.withResolvers<PostgresJsLike>()
  const settle = Promise.withResolvers<void>()

  const done = client.begin!(async tx => {
    opened.resolve(tx)
    await settle.promise
  })

  let settled = false
  // Why the transaction ended, when it ended on its own (the server dropped the connection, say)
  // rather than through commit() or rollback().
  let endedError: Error | null = null
  const settledError = () => endedError ?? new Error('Transaction is already settled')

  // A BEGIN that fails rejects `done` before the callback runs. Later, a rejection that arrives
  // before either settle call means the connection is gone. postgres.js keeps routing a
  // transaction's statements to its connection after the socket closes, and a write there throws
  // from a timer and ends the process (postgres.js 3.4.9), so nothing may reach it once it ends.
  done.catch(err => {
    opened.reject(err)
    if (!settled) endedError ??= err
  })

  const tx = fromUnsafeSql(await opened.promise, { expandArrays: false })

  return {
    db: {
      // Refuses to run once the transaction is settled or ended. A statement issued late by a
      // handler that outlived its timeout would otherwise run on a connection that has left the
      // transaction. A statement that fails because the connection died ends it on the spot,
      // before the caller's own error handling can send another down the same connection.
      executeSql: (text: string, values?: unknown[]) => settled || endedError
        ? Promise.reject(settledError())
        : tx.executeSql(text, values).catch(err => {
          if (endsSession(err)) endedError ??= err
          throw err
        })
    },
    commit: async () => {
      if (settled || endedError) throw settledError()
      settled = true

      settle.resolve()
      await done
    },
    // Statements queue per connection, so a ROLLBACK issued while the handler's own statement is in
    // flight waits as long as that statement does. Past the deadline this returns and leaves the
    // ROLLBACK queued: postgres.js keeps the connection out of the pool until it gets through.
    rollback: async () => {
      if (settled || endedError) return
      settled = true

      settle.reject(new Error('rolled back'))
      const deadline = delay(TRANSACTION_ROLLBACK_TIMEOUT_MS)

      try {
        await Promise.race([done.catch(() => {}), deadline])
      } finally {
        deadline.abort()
      }
    }
  }
}

// A driver or socket error (no SQLSTATE), or a server error severe enough to end the session.
function endsSession (err: unknown) {
  const { code, severity } = err as { code?: string, severity?: string }

  return !/^[0-9A-Z]{5}$/.test(code ?? '') || severity === 'FATAL' || severity === 'PANIC'
}
