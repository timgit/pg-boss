import type { IDatabase } from '../types.ts'

// Minimal structural type for an `@electric-sql/pglite` instance, so pg-boss does not take a
// hard dependency on the package. The query/exec methods return an object with a `rows` array;
// `listen` (optional, present on real PGlite) registers a LISTEN handler and resolves to an
// unsubscribe function.
export interface PGliteLike {
  query<T = any>(query: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(query: string): Promise<Array<{ rows: any[] }>>
  listen?(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>
}

// Adapts a PGlite instance (embedded single-connection WASM PostgreSQL) to pg-boss's IDatabase.
// PGlite is full PostgreSQL, so it needs none of the distributed compatibility flags — pair it
// with `backend: 'pglite'`. The user owns the PGlite instance lifecycle (construction and close).
//
// PGlite uses native `$1` placeholders, so no placeholder translation is needed. The one wrinkle is
// that `query()` runs a single statement only, while pg-boss issues concatenated multi-statement DDL
// (migrations/schema creation) with no parameters — those must go through `exec()`, which mirrors the
// simple-vs-extended protocol split that the default `pg.Pool`-backed driver relies on.
export function fromPglite (pglite: PGliteLike): IDatabase {
  // pg-boss issues each statement expecting connection-pool semantics: an error on one statement
  // must not affect the next. PGlite has a single connection, so a failed statement inside a
  // BEGIN...COMMIT block (e.g. a migration that rolls back) leaves the connection in an aborted
  // transaction that poisons every later query. A pooled driver sidesteps this by handing out a
  // fresh connection; we emulate it by rolling back any aborted transaction before rethrowing.
  const run = async (text: string, values?: unknown[]) => {
    if (values?.length) {
      return await pglite.query(text, values)
    }

    // No parameters: may be a multi-statement block (e.g. a `locked()` BEGIN ... RETURNING ...
    // COMMIT). exec() returns one result per statement; flatten their rows so a RETURNING in the
    // middle isn't lost behind a trailing COMMIT. This mirrors how pg-boss unwraps the array that
    // node-postgres returns for multi-statement queries (see unwrapSQLResult).
    const results = await pglite.exec(text)
    return { rows: results.flatMap(r => r.rows ?? []) }
  }

  const db: IDatabase = {
    async executeSql (text: string, values?: unknown[]) {
      try {
        return await run(text, values)
      } catch (err) {
        await pglite.query('ROLLBACK').catch(() => {})
        throw err
      }
    }
  }

  // PGlite is embedded single-connection PostgreSQL, so LISTEN/NOTIFY works entirely in-process:
  // the same instance both NOTIFYs (via pg-boss's inlined pg_notify) and delivers to listeners.
  // Only expose `listen` when the instance actually supports it (older builds/mocks may not), so
  // the notifier cleanly falls back to polling otherwise. There is no network connection to drop,
  // hence no reconnect loop — onReconnect is invoked once after the initial subscribe to mirror
  // the pooled driver and force a gap-recovery fetch.
  if (typeof pglite.listen === 'function') {
    db.listen = async (channel, onNotification, onReconnect) => {
      const unsubscribe = await pglite.listen!(channel, onNotification)
      onReconnect()
      return { close: async () => { await unsubscribe() } }
    }
  }

  return db
}
