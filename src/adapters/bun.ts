import type { IDatabase } from '../types.ts'
import { fromUnsafeSql } from './unsafeSql.ts'

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
  // Opens a transactional worker's transaction. Without it, pg-boss refuses transactional workers.
  begin?<T>(fn: (tx: BunSqlLike) => T | Promise<T>): Promise<unknown>
}

export interface BunSubscriptionLike {
  unlisten(): Promise<void> | void
}

export interface BunReservedSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown>
  release(): void
}

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
  // Bun stringifies an array parameter instead of encoding it (oven-sh/bun#18775); see expandArrayParams.
  return fromUnsafeSql(client, { expandArrays: true, mapError: withSqlState, releaseEndedTransaction: true })
}

function withSqlState (err: unknown) {
  const error = err as { code?: string, errno?: string }

  if (error?.code === BUN_SERVER_ERROR && error.errno) {
    error.code = error.errno
  }

  return err
}
