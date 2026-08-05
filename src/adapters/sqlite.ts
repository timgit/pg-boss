import type { IDatabase } from '../types.ts'
import { toSqliteTimestamp } from '../dialect.ts'

// Minimal structural type for a Bun `SQL` instance opened on a sqlite:// URL. Only `unsafe` is
// used: Bun's sqlite adapter supports no connection reservation, and its multi-statement
// execution silently drops statements and discards result rows (see scripts/spike-bun-sqlite.ts),
// so this adapter splits scripts itself and runs everything on the single logical connection.
export interface BunSqliteLike {
  unsafe(query: string, values?: unknown[]): Promise<any>
}

// SQLite extended result codes mapped to the SQLSTATE codes pg-boss keys behavior on
// (unique-violation tolerance on fetch, FK translation on schedule). The original code is
// preserved on `sqliteCode`, mirroring how fromBunSql keeps Bun's class on `bunCode`.
const SQLSTATE_BY_SQLITE_CODE: Record<string, string> = {
  SQLITE_CONSTRAINT_UNIQUE: '23505',
  SQLITE_CONSTRAINT_PRIMARYKEY: '23505',
  SQLITE_CONSTRAINT_FOREIGNKEY: '23503',
  SQLITE_CONSTRAINT_TRIGGER: '23503',
  SQLITE_CONSTRAINT_CHECK: '23514',
  SQLITE_CONSTRAINT_NOTNULL: '23502'
}

function mapSqliteError (err: any): any {
  const mapped = typeof err?.code === 'string' && SQLSTATE_BY_SQLITE_CODE[err.code]
  if (mapped) {
    err.sqliteCode = err.code
    err.code = mapped
  }
  return err
}

// Bun's sqlite binding silently binds Date objects as NULL and mis-binds plain objects, so
// convert here: Dates become the canonical dialect timestamp text (comparable against
// SQL-generated strftime output), objects and arrays become JSON text (pg-boss's bind-as-text
// convention; arrays are queried with json_each).
function toSqliteParams (values: unknown[]): unknown[] {
  return values.map((value) => {
    if (value === undefined) return null
    if (value instanceof Date) return toSqliteTimestamp(value)
    if (typeof value === 'object' && value !== null) return JSON.stringify(value)
    return value
  })
}

// Bun's sqlite driver assigns array values to $N placeholders by order of FIRST APPEARANCE in
// the SQL, not by number — `SELECT $2, $1` binds values[0] to $2. Rewriting every $N to an
// anonymous `?` and expanding the values per occurrence is unambiguous under any driver
// semantics (anonymous placeholders bind strictly positionally).
export function rewritePlaceholders (text: string, values: unknown[]): { query: string, params: unknown[] } {
  let query = ''
  const params: unknown[] = []
  let i = 0

  while (i < text.length) {
    const ch = text[i]

    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      while (j < text.length) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) { j += 2; continue }
          break
        }
        j++
      }
      query += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '$' && /[1-9]/.test(text[i + 1])) {
      let j = i + 1
      while (j < text.length && /[0-9]/.test(text[j])) j++
      const index = parseInt(text.slice(i + 1, j), 10)
      query += '?'
      params.push(values[index - 1])
      i = j
    } else {
      query += ch
      i++
    }
  }

  return { query, params }
}

// Splits a multi-statement script into single statements, respecting single-quoted strings
// (with '' escapes), double-quoted identifiers, and -- / block comments. Needed because Bun's
// sqlite `unsafe` mishandles multi-statement strings (spike), and statements must run one at a
// time to keep their result rows.
export function splitStatements (script: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  while (i < script.length) {
    const ch = script[i]
    const next = script[i + 1]

    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      while (j < script.length) {
        if (script[j] === quote) {
          if (script[j + 1] === quote) { j += 2; continue }
          break
        }
        j++
      }
      current += script.slice(i, j + 1)
      i = j + 1
    } else if (ch === '-' && next === '-') {
      const end = script.indexOf('\n', i)
      const j = end === -1 ? script.length : end
      current += script.slice(i, j)
      i = j
    } else if (ch === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2)
      const j = end === -1 ? script.length : end + 2
      current += script.slice(i, j)
      i = j
    } else if (ch === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      i++
    } else {
      current += ch
      i++
    }
  }

  if (current.trim()) statements.push(current.trim())
  return statements
}

// One serialization chain per Bun SQL instance, shared across every adapter wrapping it. SQLite
// is a single logical connection: a query issued while a transaction block is open interleaves
// into that transaction and is committed or rolled back with it (verified in the spike), so every
// executeSql call and every withTransaction block runs to completion before the next starts.
const locks = new WeakMap<BunSqliteLike, Promise<unknown>>()

function serialize<T> (sql: BunSqliteLike, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sql) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(sql, next.then(() => undefined, () => undefined))
  return next
}

const initialized = new WeakSet<BunSqliteLike>()

// Adapts a Bun `SQL` instance opened on a sqlite:// URL to pg-boss's IDatabase — pair it with
// `backend: 'sqlite'`. The user owns the instance lifecycle (construction and close()).
export function fromBunSqlite (sql: BunSqliteLike): IDatabase {
  // foreign_keys defaults OFF in SQLite and pg-boss depends on FK errors firing (queue
  // existence on schedule/send); busy_timeout makes concurrent writers on a shared file wait
  // instead of failing with SQLITE_BUSY.
  const init = async () => {
    if (initialized.has(sql)) return
    initialized.add(sql)
    await sql.unsafe('PRAGMA foreign_keys = ON')
    await sql.unsafe('PRAGMA busy_timeout = 5000')
  }

  const normalize = (result: any): { rows: any[] } => {
    return { rows: Array.isArray(result) ? [...result] : [] }
  }

  // Single-connection semantics: a failed statement inside an explicit BEGIN...COMMIT script
  // leaves the connection mid-transaction, poisoning every later query — roll back before
  // rethrowing (same guard as fromPglite). Inside withTransaction the rollback is skipped:
  // SQLite keeps a transaction usable after a statement error, so the caller may handle the
  // error and continue, and the block-level catch owns the rollback.
  const run = async (text: string, values?: unknown[], insideTx = false): Promise<{ rows: any[] }> => {
    await init()

    try {
      if (values?.length) {
        const { query, params } = rewritePlaceholders(text, values)
        return normalize(await sql.unsafe(query, toSqliteParams(params)))
      }

      const statements = splitStatements(text)

      if (statements.length === 1) {
        return normalize(await sql.unsafe(statements[0]))
      }

      const rows: any[] = []
      for (const statement of statements) {
        const result = await sql.unsafe(statement)
        if (Array.isArray(result)) rows.push(...result)
      }
      return { rows }
    } catch (err) {
      if (!insideTx) await sql.unsafe('ROLLBACK').catch(() => {})
      throw mapSqliteError(err)
    }
  }

  return {
    async executeSql (text: string, values?: unknown[]) {
      return serialize(sql, () => run(text, values))
    },

    // The tx database runs statements directly — the serialization lock is already held for the
    // whole block, and re-acquiring it from inside would deadlock.
    async withTransaction (fn) {
      return serialize(sql, async () => {
        await init()
        await sql.unsafe('BEGIN IMMEDIATE')
        try {
          const result = await fn({ executeSql: (text, values) => run(text, values, true) })
          await sql.unsafe('COMMIT')
          return result
        } catch (err) {
          await sql.unsafe('ROLLBACK').catch(() => {})
          throw mapSqliteError(err)
        }
      })
    }
  }
}
