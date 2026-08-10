import assert from 'node:assert'
// @ts-ignore -- @types/bun is an optional peer dependency, so 'bun' may not resolve for a
// consumer type-checking this package's shipped source.
import { SQL } from 'bun'
import { fromBunSql, type BunSqlLike } from './adapters/bun.ts'
import type * as types from './types.ts'

// The built-in database: Bun's SQL client wrapped by the fromBunSql adapter, so the default
// driver carries the same workarounds (SQLSTATE promotion, json cast rewriting, reserved
// transaction blocks) as a user-supplied Bun.SQL handle. Bun implements no LISTEN, so this
// driver exposes no `listen` and `useListenNotify` degrades to polling (see notifier.ts).
// Not an EventEmitter: Bun's client has no background-error hook (unlike pg.Pool's idle-client
// 'error'), so connection failures surface as rejections on the operation that hit them.
// Explicit allowlist: the resolved config carries every constructor option, and only the
// connection settings may reach Bun's SQL constructor. Deliberately excludes `prepare` and
// `bigint` — the adapter's parameter encoding depends on both: with `prepare: false` bun has no
// prepared-statement type to encode a live object bound to an uncast jsonb placeholder.
const SQL_OPTION_KEYS = [
  'url', 'hostname', 'port', 'username', 'password', 'database',
  'tls', 'max', 'connectionTimeout', 'idleTimeout', 'maxLifetime', 'path'
] as const satisfies readonly (keyof types.DatabaseOptions)[]

// Structural type for Bun's SQL client, mirroring adapters/bun.ts, so the shipped TypeScript
// type-checks in a project that has no @types/bun installed.
interface BunSqlClient extends BunSqlLike {
  close(): Promise<void>
  begin<T>(fn: (tx: BunSqlLike) => Promise<T>): Promise<T>
}

class Db implements types.IDatabase {
  private sql!: BunSqlClient
  private adapter!: types.IDatabase
  private config: types.DatabaseOptions
  /** @internal */
  readonly _pgbdb: true
  opened: boolean

  constructor (config: types.DatabaseOptions) {
    config.application_name = config.application_name || 'bunboss'

    this.config = config
    this._pgbdb = true
    this.opened = false
  }

  #sqlOptions () {
    const config = this.config
    // application_name is the one setting Bun has no top-level option for.
    const options: Record<string, unknown> = {
      connection: { application_name: config.application_name }
    }

    for (const key of SQL_OPTION_KEYS) {
      if (config[key] !== undefined) options[key] = config[key]
    }

    return options
  }

  async open () {
    this.sql = new SQL(this.#sqlOptions()) as unknown as BunSqlClient
    this.adapter = fromBunSql(this.sql)
    this.opened = true
  }

  async close () {
    if (this.opened) {
      this.opened = false
      await this.sql.close()
    }
  }

  async executeSql (text: string, values?: unknown[]) {
    assert(this.opened, 'Database not opened. Call open() before executing SQL.')

    return await this.adapter.executeSql(text, values)
  }

  async withTransaction<T> (fn: (db: types.IDatabase) => Promise<T>): Promise<T> {
    assert(this.opened, 'Database not opened. Call open() before executing SQL.')

    // The transaction handle satisfies BunSqlLike, so the adapter runs the block un-reserved on
    // the transaction's own connection; sql.begin commits on resolve and rolls back on throw.
    return await this.sql.begin(tx => fn(fromBunSql(tx)))
  }
}

export default Db
