import EventEmitter from 'node:events'
import assert from 'node:assert'
import { SQL } from 'bun'
import { fromBunSql, type BunSqlLike } from './adapters/bun.ts'
import type * as types from './types.ts'

// The built-in database: Bun's SQL client wrapped by the fromBunSql adapter, so the default
// driver carries the same workarounds (SQLSTATE promotion, json cast rewriting, reserved
// transaction blocks) as a user-supplied Bun.SQL handle. Bun implements no LISTEN, so this
// driver exposes no `listen` and `useListenNotify` degrades to polling (see notifier.ts).
class Db extends EventEmitter implements types.IDatabase, types.EventsMixin {
  private sql!: SQL
  private adapter!: types.IDatabase
  private config: types.DatabaseOptions
  /** @internal */
  readonly _pgbdb: true
  opened: boolean

  constructor (config: types.DatabaseOptions) {
    super()

    config.application_name = config.application_name || 'bunboss'
    config.connectionTimeoutMillis ??= 10000

    this.config = config
    this._pgbdb = true
    this.opened = false
  }

  events = {
    error: 'error'
  }

  // Explicit allowlist: the resolved config carries every constructor option, and only the
  // connection settings may reach Bun's SQL constructor.
  #sqlOptions () {
    const config = this.config
    const options: Record<string, unknown> = {
      // Bun takes seconds where pg took milliseconds.
      connectionTimeout: config.connectionTimeoutMillis! / 1000,
      connection: { application_name: config.application_name }
    }

    if (config.max !== undefined) options.max = config.max
    if (config.connectionString !== undefined) options.url = config.connectionString
    if (config.host !== undefined) options.hostname = config.host
    if (config.port !== undefined) options.port = Number(config.port)
    if (config.user !== undefined) options.username = config.user
    if (config.password !== undefined) options.password = config.password
    if (config.database !== undefined) options.database = config.database
    if (config.ssl !== undefined) options.tls = config.ssl

    return options
  }

  async open () {
    this.sql = new SQL(this.#sqlOptions())
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
    return await this.sql.begin(tx => fn(fromBunSql(tx as unknown as BunSqlLike))) as T
  }
}

export default Db
