import type { IDatabase } from '../types.ts'
import { expandArrayParams } from './placeholders.ts'

// Minimal structural type for a `Bun.SQL` client, so pg-boss does not take a hard dependency on
// Bun. `unsafe` runs a statement (or a multi-statement script, when there are no parameters) and
// `reserve` pins a connection out of the pool, which is the only place Bun accepts a raw BEGIN.
export interface BunSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  reserve(): Promise<BunReservedSqlLike>
  // Added in Bun 1.4.0 (oven-sh/bun#32089); absent on older runtimes, hence optional.
  listen?(
    channel: string,
    onNotification: (payload: string) => void,
    onSubscribe?: () => void
  ): Promise<BunSubscriptionLike>
}

export interface BunSubscriptionLike {
  unlisten(): Promise<void> | void
}

export interface BunReservedSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  release(): void
}

// pg-boss ships schema installation, migration and maintenance as `BEGIN; ... COMMIT;` scripts
// (plans.transaction / plans.locked). Bun rejects those on a pooled connection with `Only use
// sql.begin, sql.reserved or max: 1`, because the pool is free to hand the next statement to a
// different connection. A reserved connection is pinned for its lifetime and takes them as-is.
const STARTS_TRANSACTION = /^\s*BEGIN\b/i

// Bun reports every server error as ERR_POSTGRES_SERVER_ERROR and puts the SQLSTATE in `errno`,
// where node-postgres puts it in `code`. pg-boss reads `code` to recognise a handful of states it
// treats as control flow rather than failure - 23505 from a lost fetch race, 22012 from the
// in-SQL insert guard, 25001 from REINDEX inside a transaction - so an unmapped error turns a
// tolerated race into a thrown one.
const BUN_SERVER_ERROR = 'ERR_POSTGRES_SERVER_ERROR'

/**
 * Adapts a `Bun.SQL` client to pg-boss's IDatabase, for running pg-boss on Bun's built-in
 * PostgreSQL driver instead of the bundled `pg` pool.
 *
 * @example
 * ```ts
 * import { SQL } from 'bun'
 * import { PgBoss, fromBunSql } from 'pg-boss'
 *
 * const boss = new PgBoss({ db: fromBunSql(new SQL(connectionString)) })
 * await boss.start()
 * ```
 *
 * The caller owns the client's lifecycle: pg-boss never calls `end()` on it.
 *
 * `useListenNotify` needs `sql.listen()`, which Bun added in 1.4.0. On an older runtime the adapter
 * exposes no `listen` and pg-boss falls back to polling.
 */
export function fromBunSql (client: BunSqlLike): IDatabase {
  const db: IDatabase = {
    async executeSql (text: string, values?: unknown[]) {
      const query = expandArrayParams(text, values)

      // A parameterless call goes through the simple protocol, which is what lets a multi-statement
      // script run at all; pg-boss only ever concatenates statements when there is nothing to bind.
      const run = (target: BunSqlLike | BunReservedSqlLike) => query.values.length
        ? target.unsafe(query.text, query.values)
        : target.unsafe(query.text)

      try {
        return unwrapBunResult(await (STARTS_TRANSACTION.test(text) ? runReserved(client, run) : run(client)))
      } catch (err) {
        throw withSqlState(err)
      }
    }
  }

  // Bun's third argument fires on the initial subscribe and again after each reconnect - it
  // re-establishes the connection and re-subscribes every channel on its own - which is exactly
  // what pg-boss's onReconnect is for: a notification sent while the listener was down is gone,
  // so the gap has to be closed by a fetch. Only expose `listen` when the client actually has it
  // (Bun < 1.4.0, or a mock), so the notifier cleanly falls back to polling otherwise.
  if (typeof client.listen === 'function') {
    db.listen = async (channel, onNotification, onReconnect) => {
      const subscription = await client.listen!(channel, onNotification, onReconnect)

      return { close: async () => { await subscription.unlisten() } }
    }
  }

  return db
}

async function runReserved (client: BunSqlLike, run: (target: BunReservedSqlLike) => Promise<unknown>) {
  const reserved = await client.reserve()

  try {
    return await run(reserved)
  } catch (err) {
    // A script that fails after its BEGIN leaves the session in an aborted transaction. node-postgres
    // discards a client whose query failed, but Bun's pool would hand this one to the next caller,
    // whose statement would fail with "current transaction is aborted".
    await reserved.unsafe('ROLLBACK').catch(() => {})
    throw err
  } finally {
    reserved.release()
  }
}

// Bun returns the rows of a single statement as a flat array, and one such array per statement for
// a multi-statement script. Flatten the latter so a RETURNING in the middle of a transaction block
// is not lost behind the trailing COMMIT's empty result - the same unwrapping the PGlite adapter
// does for exec() and pg-boss does for node-postgres (see unwrapSQLResult).
function unwrapBunResult (result: unknown): { rows: any[] } {
  if (!Array.isArray(result)) {
    return { rows: [] }
  }

  return { rows: result.some(Array.isArray) ? result.flat() : result }
}

function withSqlState (err: unknown) {
  const error = err as { code?: string, errno?: string }

  if (error?.code === BUN_SERVER_ERROR && error.errno) {
    error.code = error.errno
  }

  return err
}
