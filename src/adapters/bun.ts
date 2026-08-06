import type { IDatabase } from '../types.ts'

// Minimal structural types for Bun's built-in SQL client (`import { SQL } from 'bun'`), so bun-boss
// takes no dependency on bun types and still type-checks under node. A pooled `SQL` client and the
// transaction object handed to `sql.begin()` are interchangeable here — both expose `unsafe()` —
// which is what lets one factory serve the driver-level and per-transaction use cases.
export interface BunSqlLike {
  unsafe(query: string, values?: unknown[]): Promise<any>
  // All three handles expose `reserve`; `release` and `savepoint` are what tell them apart. The
  // adapter only reads them to identify the pool — it never calls either. See isPooled below.
  reserve?(): Promise<BunReservedLike>
  /** Present only on a reserved connection. */
  release?: unknown
  /** Present only on a `sql.begin()` transaction or savepoint scope. */
  savepoint?: unknown
}

export interface BunReservedLike {
  unsafe(query: string, values?: unknown[]): Promise<any>
  release(): void
}

// Bun refuses to run explicit transaction control on a pooled connection, since the next statement
// could land on a different connection. bun-boss issues such blocks from plans.transaction()/locked()
// for schema install, migrations and maintenance, so those get retried on a reserved connection.
const UNSAFE_TRANSACTION = 'ERR_POSTGRES_UNSAFE_TRANSACTION'

// Only a pooled handle may be pinned with reserve(). A reserved connection and a transaction scope
// are already pinned, and reserving from inside a transaction would quietly run the block on a
// different connection — committing it independently of the caller's work. bun-boss never sends a
// transaction block through a caller-supplied handle, so that shape fails loudly instead.
function isPooled (sql: BunSqlLike): boolean {
  return typeof sql.reserve === 'function' && sql.release === undefined && sql.savepoint === undefined
}

// Whether a statement may open a transaction, and so needs a connection of its own. Deliberately
// broad: it matches BEGIN anywhere, including inside a plpgsql body or a string literal, because
// over-reserving only costs a pool checkout while under-reserving would silently spread one
// transaction across several connections. Bun's own guard is a prefix test that does not look past
// a leading comment, so this is checked up front rather than relying solely on that rejection.
const TRANSACTION_REGEX = /\bBEGIN\b|\bSTART\s+TRANSACTION\b/i

// Bun puts its own error class on `code` and the postgres SQLSTATE on `errno`, where every other
// driver bun-boss supports puts the SQLSTATE on `code`. bun-boss keys real behavior on it — a fetch
// tolerates 23505 from a queue policy's unique index rather than failing (manager.ts), and a job
// insert translates the 22012 its ON CONFLICT guard raises into an actionable message — so the
// SQLSTATE is promoted onto `code` and bun's class kept on `bunCode`.
const SERVER_ERROR = 'ERR_POSTGRES_SERVER_ERROR'

// Bun 1.3.x hands a pooled connection to a waiting query in the window between a transaction block
// failing and the ROLLBACK that clears its aborted state, so an unrelated query fails with 25P02.
// Reserving does not help — the leak is inside the pool the reserved connection came from. Rather
// than prevent it, treat the aborted transaction as transient and clear it on the way through.
const ABORTED_TRANSACTION = '25P02'
const ABORTED_RETRY_LIMIT = 3

function promoteSqlState (err: any): any {
  if (err?.code === SERVER_ERROR && typeof err.errno === 'string') {
    err.bunCode = err.code
    err.code = err.errno
  }

  return err
}

// Bun JSON.stringifys a json/jsonb parameter, but bun-boss binds most of those already encoded, so
// they arrive double-encoded and `json_to_recordset($1::json)` fails on the scalar. Casting through
// text (`$1::text::json`, semantically identical for postgres) makes bun pass the value through and
// postgres do the parsing, exactly as node-postgres does today. Verified against bun 1.4.0.
//
// The rewrite also decides how the matching value is encoded, covering both conventions bun-boss
// uses: pre-encoded text passes through, while a live object (complete/fail bind the serialized-error
// output from src/serialize-error.ts) is encoded here rather than stringified into "[object Object]"
// by the text binding.
const JSON_CAST_REGEX = /\$(\d+)\s*::\s*(jsonb?)\b/gi

// A placeholder can also be typed as json by the operator it sits under rather than by a cast:
// findJobs filters with `data @> $n`, where postgres infers jsonb from the column. Give those the
// same explicit cast so the rule stays "a json argument is bound as text". A placeholder that
// already carries its own cast is left for the pass above — the word boundary stops `\d+` from
// backtracking into a partial index (`$1` out of `$12::jsonb`) just to satisfy the lookahead.
const JSON_OPERATOR_REGEX = /(@>|<@)(\s*)\$(\d+)\b(?!\s*::)/g

function rewriteJsonCasts (text: string): { query: string, jsonParams: Set<number> } {
  const jsonParams = new Set<number>()

  const query = text
    .replace(JSON_OPERATOR_REGEX, (_match, operator: string, space: string, index: string) => {
      jsonParams.add(Number(index))
      return `${operator}${space}$${index}::text::jsonb`
    })
    .replace(JSON_CAST_REGEX, (_match, index: string, type: string) => {
      jsonParams.add(Number(index))
      return `$${index}::text::${type}`
    })

  return { query, jsonParams }
}

function toJsonParam (value: unknown): unknown {
  if (value === null || value === undefined || typeof value === 'string') {
    return value
  }

  return JSON.stringify(value)
}

// Bun serializes an array parameter by joining its elements with commas and no braces, which
// postgres rejects as a malformed array literal — so every `= ANY($n::uuid[])` and `$n::text[]`
// query bun-boss emits fails. Encode the array literal ourselves, the way node-postgres does; bun
// passes a string through untouched and the explicit ::type[] cast bun-boss always writes gives
// postgres the element type. A literal string keeps working if bun later binds arrays natively.
// Verified against bun 1.4.0.
function toArrayLiteral (values: readonly unknown[]): string {
  const elements = values.map(value => {
    if (value === null || value === undefined) {
      return 'NULL'
    }

    if (Array.isArray(value)) {
      return toArrayLiteral(value)
    }

    const text = value instanceof Date ? value.toISOString() : String(value)

    // Quoting every element keeps commas, braces and whitespace inside a value from being read as
    // array syntax; backslashes and double quotes then need escaping within the quotes.
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  })

  return `{${elements.join(',')}}`
}

// The rewrite above identifies every json argument, so anything left that is an array is bound to a
// ::type[] parameter and wants an array literal rather than a json document.
function toBunParams (values: readonly unknown[], jsonParams: Set<number>): unknown[] {
  return values.map((value, i) => {
    if (jsonParams.has(i + 1)) {
      return toJsonParam(value)
    }

    if (Array.isArray(value)) {
      return toArrayLiteral(value)
    }

    // ISO text parses to the identical timestamptz, and unlike bun's native Date encoding it also
    // survives `prepare: false`, where bun falls back to String(value) — a form postgres rejects.
    return value instanceof Date ? value.toISOString() : value
  })
}

// A single-statement query resolves to bun's SQLResultArray: the rows themselves, not { rows }. A
// parameterless query may hold several statements, and those resolve to one row array per
// statement — flatten them so a RETURNING in the middle isn't lost behind a trailing COMMIT (the
// same unwrapping fromPglite does for exec()). Rows are objects, so an array of arrays can only be
// the multi-statement shape.
//
// Either way the rows are copied into a plain array: SQLResultArray carries count/command/
// affectedRows as enumerable own properties, and IDatabase promises a plain any[].
function normalizeResult (result: any): { rows: any[] } {
  if (!Array.isArray(result)) {
    // v8 ignore next
    return { rows: [] }
  }

  if (result.length > 0 && result.every(Array.isArray)) {
    return { rows: result.flat() }
  }

  return { rows: [...result] }
}

async function executeReserved (sql: BunSqlLike, text: string): Promise<any> {
  const reserved = await sql.reserve!()

  try {
    return await reserved.unsafe(text)
  } catch (err) {
    // A statement that fails inside BEGIN...COMMIT leaves the session in an aborted transaction,
    // which would poison whoever picks this connection up next. Roll it back before releasing.
    await reserved.unsafe('ROLLBACK').catch(() => {})
    throw err
  } finally {
    reserved.release()
  }
}

/**
 * Adapts Bun's built-in SQL client to bun-boss's {@link IDatabase}.
 *
 * Works both as the connection for an entire bun-boss instance — the built-in driver wraps its own
 * `SQL` client with this same adapter — and as a per-operation handle that composes job writes into
 * an existing `sql.begin()` transaction. The caller owns the client's lifecycle — bun-boss never
 * closes it.
 *
 * Bun implements neither LISTEN nor NOTIFY, so no `listen` is exposed and `useListenNotify` falls
 * back to polling with a warning (see notifier.ts). The `pg_notify` bun-boss inlines into inserts is
 * evaluated by postgres and still fires for any listener on another driver.
 *
 * @example
 * ```ts
 * import { SQL } from 'bun'
 * import { BunBoss, fromBunSql } from 'bun-boss'
 *
 * const sql = new SQL('postgres://localhost/mydb')
 * const boss = new BunBoss({ db: fromBunSql(sql) })
 *
 * await sql.begin(async (tx) => {
 *   await tx`INSERT INTO orders (item) VALUES (${'widget'})`
 *   await boss.send('order-processing', { item: 'widget' }, { db: fromBunSql(tx) })
 * })
 * ```
 */
export function fromBunSql (sql: BunSqlLike): IDatabase {
  async function run (query: string, values?: unknown[], jsonParams?: Set<number>) {
    // Only the simple protocol accepts the multi-statement blocks below, and bun-boss only ever
    // sends those without parameters — the same split fromPglite makes between query and exec.
    if (values?.length) {
      return normalizeResult(await sql.unsafe(query, toBunParams(values, jsonParams!)))
    }

    if (!isPooled(sql)) {
      return normalizeResult(await sql.unsafe(query))
    }

    if (!TRANSACTION_REGEX.test(query)) {
      try {
        return normalizeResult(await sql.unsafe(query))
      } catch (err: any) {
        // Backstop for anything bun rejects that the check above did not anticipate. Bun rejects
        // before running any of the statement, so replaying it on a pinned connection is safe.
        if (err?.code !== UNSAFE_TRANSACTION) {
          throw err
        }
      }
    }

    return normalizeResult(await executeReserved(sql, query))
  }

  return {
    async executeSql (text: string, values?: unknown[]) {
      const { query, jsonParams } = rewriteJsonCasts(text)

      for (let attempt = 0; ; attempt++) {
        try {
          // A retry of a parameterless statement carries its own cure. Sending `ROLLBACK; <stmt>`
          // as one simple query is atomic with respect to which connection serves it: on the
          // poisoned one the ROLLBACK clears the aborted transaction and the statement then runs,
          // and on a healthy one the ROLLBACK is a no-op warning. A parameterized statement cannot
          // carry a second command, so those get a standalone ROLLBACK below and a plain retry.
          const healing = attempt > 0 && !values?.length

          return await run(healing ? `ROLLBACK; ${query}` : query, values, jsonParams)
        } catch (err: any) {
          promoteSqlState(err)

          // 25P02 reaching this adapter is always spurious: every transaction block it issues ends
          // in COMMIT or is rolled back before the connection goes back to the pool, so an aborted
          // transaction on a connection handed to us is bun 1.3.x leaking one (see ISSUES.txt #3).
          if (err?.code !== ABORTED_TRANSACTION || attempt >= ABORTED_RETRY_LIMIT || !isPooled(sql)) {
            throw err
          }

          if (values?.length) {
            await sql.unsafe('ROLLBACK').catch(() => {})
          }
        }
      }
    }
  }
}
