import type { IDatabase } from '../types.ts'
import { expandArrayParams } from './placeholders.ts'

// Bun.SQL copied its client API from postgres.js, so both drivers run pg-boss the same way: `unsafe`
// runs a statement (or a multi-statement script, when there are no parameters), `reserve` pins a
// connection out of the pool, and `listen` subscribes a channel on a connection of its own. A
// postgres.js transaction has neither of the last two, and needs neither: it is already pinned.
export interface UnsafeSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  reserve?(): Promise<ReservedUnsafeSqlLike>
  listen?(
    channel: string,
    onNotification: (payload: string) => void,
    onSubscribe?: () => void
  ): Promise<{ unlisten(): Promise<void> | void }>
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
