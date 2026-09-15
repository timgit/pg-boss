import type { IDatabase } from '../types.ts'

// Minimal structural type for an `@electric-sql/pglite` instance, so pg-boss does not take a
// hard dependency on the package. The query/exec methods return an object with a `rows` array;
// `listen` (optional, present on real PGlite) registers a LISTEN handler and resolves to an
// unsubscribe function. `onLeaderChange` is present only on `PGliteWorker` — see below.
export interface PGliteLike {
  query<T = any>(query: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(query: string): Promise<Array<{ rows: any[] }>>
  listen?(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>
  onLeaderChange?(callback: () => void): () => void
}

// PGliteWorker's error when leadership moves while a call is in flight. Matched on the message
// rather than the constructor name: the class is anonymous after bundling, so `name` is just
// 'Error', while the message is fixed in the worker source.
const LEADER_CHANGED_MESSAGE = 'Leader changed, pending operation in indeterminate state'

function isLeaderChange (err: unknown) {
  return err instanceof Error && err.message === LEADER_CHANGED_MESSAGE
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

  // The statements every session must carry, kept so they can be reapplied. A plain PGlite has one
  // session for the life of the instance and never needs that; PGliteWorker does — see below.
  let sessionStatements: string[] = []
  let unsubscribeLeaderChange: (() => void) | null = null
  // While a reapply is in flight, every statement waits for it. Without this a query issued between
  // the leader change and the reapply lands on a session that has not been set up yet.
  let reapplying: Promise<void> | null = null

  const applySessionStatements = async () => {
    for (const statement of sessionStatements) {
      await run(statement)
    }
  }

  // Note what this cannot fix: because one leader instance serves every tab, session state is shared
  // by all of them. A SET issued through one tab's adapter applies to every other tab's queries
  // against that database, and there is no way to scope it to the instance that asked for it.
  //
  // Only the PGliteWorker leader holds an actual PGlite instance; the other tabs proxy into it. When
  // the leader tab goes away, the next tab's worker constructs a *new* PGlite over the same data
  // directory — a new backend, and so a new session. Anything set with SET is gone, and nothing in
  // the worker replays it, so without this the session would silently revert to defaults: for the
  // clock override specifically, back to real time with no error anywhere.
  const watchLeaderChange = () => {
    if (unsubscribeLeaderChange || typeof pglite.onLeaderChange !== 'function') {
      return
    }

    unsubscribeLeaderChange = pglite.onLeaderChange(() => {
      if (!sessionStatements.length) return
      reapplying = applySessionStatements().catch(() => {}).then(() => { reapplying = null })
    })
  }

  const db: IDatabase = {
    // A plain PGlite is one session for the life of the instance, so these are applied once and
    // every later statement sees them. A pooled driver re-runs them per connection; here the only
    // thing that can take the session away is a PGliteWorker leader change.
    async setSessionStatements (statements: string[]) {
      sessionStatements = statements

      if (!statements.length) {
        unsubscribeLeaderChange?.()
        unsubscribeLeaderChange = null
        return
      }

      await applySessionStatements()
      watchLeaderChange()
    },
    async executeSql (text: string, values?: unknown[]) {
      if (reapplying) {
        await reapplying
      }

      try {
        return await run(text, values)
      } catch (err) {
        // A leader change leaves nothing to roll back on this side: the transaction died with the
        // old leader's instance, and a ROLLBACK now would go to a different session that was never
        // in it. The statement's own outcome is genuinely unknown, which is what the error says.
        if (!isLeaderChange(err)) {
          await pglite.query('ROLLBACK').catch(() => {})
        }

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
