import type { IDatabase } from '../types.ts'
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
  return fromUnsafeSql(client, { expandArrays: false })
}
