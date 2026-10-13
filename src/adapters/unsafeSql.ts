import type { IDatabase, TransactionHandle } from '../types.ts'
import { TRANSACTION_ROLLBACK_TIMEOUT_MS } from '../db.ts'
import { delay } from '../tools.ts'
import { expandArrayParams } from './placeholders.ts'

// Bun.SQL copied its client API from postgres.js, so both drivers run pg-boss the same way: `unsafe`
// runs a statement (or a multi-statement script, when there are no parameters), `reserve` pins a
// connection out of the pool, `listen` subscribes a channel on a connection of its own, and `begin`
// runs a callback in a transaction. A postgres.js transaction has none of the last three, and needs
// none: it is already pinned.
export interface UnsafeSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  reserve?(): Promise<ReservedUnsafeSqlLike>
  listen?(
    channel: string,
    onNotification: (payload: string) => void,
    onSubscribe?: () => void
  ): Promise<{ unlisten(): Promise<void> | void }>
  begin?<T>(fn: (tx: UnsafeSqlLike) => T | Promise<T>): Promise<unknown>
}

export interface ReservedUnsafeSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  release(): void
}

interface UnsafeSqlOptions {
  // Rewrite each array-cast parameter into ARRAY[...] of scalars, for a driver that cannot encode one.
  expandArrays: boolean
  // Move a driver-specific error shape onto the one pg-boss reads.
  mapError?: (err: unknown) => unknown
  // Return from a transaction's begin() callback once the server has ended the transaction. Bun's
  // sql.end() waits for that callback forever. postgres.js answers it with a ROLLBACK on the dead
  // connection, which throws from a timer and ends the process (3.4.9), so its callback stays parked.
  releaseEndedTransaction?: boolean
}

// pg-boss ships schema installation, migration and maintenance as `BEGIN; ... COMMIT;` scripts
// (plans.transaction / plans.locked). Both drivers reject those on a pooled connection, because the
// pool is free to hand the next statement to a different connection. A reserved connection is
// pinned for its lifetime and takes them as-is.
const STARTS_TRANSACTION = /^\s*BEGIN\b/i

export function fromUnsafeSql (client: UnsafeSqlLike, options: UnsafeSqlOptions): IDatabase {
  const db: IDatabase = {
    async executeSql (text: string, values?: unknown[]) {
      // node-postgres binds an undefined value as null, and pg-boss leaves optional values undefined
      // (a schedule with no data, say). postgres.js refuses one with UNDEFINED_VALUE.
      const bound = values?.map(value => value === undefined ? null : value)

      const query = options.expandArrays
        ? expandArrayParams(text, bound)
        : { text, values: bound ?? [] }

      // A parameterless call goes through the simple protocol, which is what lets a multi-statement
      // script run at all; pg-boss only ever concatenates statements when there is nothing to bind.
      const run = (target: UnsafeSqlLike | ReservedUnsafeSqlLike) => query.values.length
        ? target.unsafe(query.text, query.values)
        : target.unsafe(query.text)

      try {
        const reserve = STARTS_TRANSACTION.test(text) && client.reserve

        return unwrapRows(await (reserve ? runReserved(client, run) : run(client)))
      } catch (err) {
        throw options.mapError ? options.mapError(err) : err
      }
    }
  }

  // Both drivers fire the third argument on the initial subscribe and again after each reconnect -
  // they re-establish the connection and re-subscribe every channel on their own - which is exactly
  // what pg-boss's onReconnect is for: a notification sent while the listener was down is gone, so
  // the gap has to be closed by a fetch. Only expose `listen` when the client actually has it (Bun
  // < 1.4.0, or a mock), so the notifier cleanly falls back to polling otherwise.
  if (typeof client.listen === 'function') {
    db.listen = async (channel, onNotification, onReconnect) => {
      const subscription = await client.listen!(channel, onNotification, onReconnect)

      return { close: async () => { await subscription.unlisten() } }
    }
  }

  if (typeof client.begin === 'function') {
    db.beginTransaction = () => beginTransaction(client, options)
  }

  return db
}

async function runReserved (client: UnsafeSqlLike, run: (target: ReservedUnsafeSqlLike) => Promise<unknown>) {
  const reserved = await client.reserve!()

  try {
    return await run(reserved)
  } catch (err) {
    // A script that fails after its BEGIN leaves the session in an aborted transaction. node-postgres
    // discards a client whose query failed, but these pools would hand this one to the next caller,
    // whose statement would fail with "current transaction is aborted".
    await reserved.unsafe('ROLLBACK').catch(() => {})
    throw err
  } finally {
    reserved.release()
  }
}

// Both drivers return the rows of a single statement as a flat array, and one such array per
// statement for a multi-statement script. Flatten the latter so a RETURNING in the middle of a
// transaction block is not lost behind the trailing COMMIT's empty result - the same unwrapping the
// PGlite adapter does for exec() and pg-boss does for node-postgres (see unwrapSQLResult).
function unwrapRows (result: unknown): { rows: any[] } {
  if (!Array.isArray(result)) {
    return { rows: [] }
  }

  return { rows: result.some(Array.isArray) ? result.flat() : result }
}

// A transactional worker settles its transaction from a different call frame than the one that
// opened it, and sql.begin() wants a callback that does both. The callback here parks on a promise
// that commit() resolves and rollback() rejects, which leaves BEGIN, COMMIT, ROLLBACK and a dropped
// connection to the driver: the connection goes back to the pool only once the transaction is over.
async function beginTransaction (client: UnsafeSqlLike, options: UnsafeSqlOptions): Promise<TransactionHandle> {
  const mapError = (err: unknown) => options.mapError ? options.mapError(err) : err
  const opened = Promise.withResolvers<UnsafeSqlLike>()
  const settle = Promise.withResolvers<void>()

  const done = client.begin!(async tx => {
    opened.resolve(tx)
    await settle.promise
  }).catch(err => { throw mapError(err) })

  let settled = false
  // Why the transaction ended, when it ended on its own (the server dropped the connection, say)
  // rather than through commit() or rollback().
  let endedError: unknown = null
  const settledError = () => endedError ?? new Error('Transaction is already settled')

  const end = (err: unknown) => {
    if (settled || endedError) return
    endedError = err
    if (options.releaseEndedTransaction) settle.reject(err)
  }

  // A BEGIN that fails rejects `done` before the callback runs. Later, a rejection that arrives
  // before either settle call means the connection is gone. postgres.js keeps routing a
  // transaction's statements to its connection after the socket closes, and a write there throws
  // from a timer and ends the process (postgres.js 3.4.9), so nothing may reach it once it ends.
  done.catch(err => {
    opened.reject(err)
    end(err)
  })

  const tx = fromUnsafeSql(await opened.promise, options)

  return {
    db: {
      // Refuses to run once the transaction is settled or ended. A statement issued late by a
      // handler that outlived its timeout would otherwise run on a connection that has left the
      // transaction. A statement that fails because the connection died ends it on the spot,
      // before the caller's own error handling can send another down the same connection.
      executeSql: (text: string, values?: unknown[]) => settled || endedError
        ? Promise.reject(settledError())
        : tx.executeSql(text, values).catch(err => {
          if (endsSession(err)) end(err)
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
    // ROLLBACK queued: the driver keeps the connection out of the pool until it gets through.
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
