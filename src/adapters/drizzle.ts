import type { IDatabase } from '../types.ts'
import { ARRAY_CAST, parsePlaceholders } from './placeholders.ts'
import { unwrapSQLResult } from '../tools.ts'

export interface DrizzleTransactionLike {
  // node-postgres returns { rows }, or an array of them for multi-statement queries;
  // postgres-js returns the rows themselves as a flat array, or one per statement (see unwrapSQLResult).
  execute(query: unknown): Promise<{ rows: any[] } | { rows: any[] }[] | any[]>
}

export interface DrizzleSqlTagLike {
  (strings: TemplateStringsArray, ...values: unknown[]): unknown
  param(value: unknown): unknown
}

/**
 * Wraps a drizzle-orm transaction as an {@link IDatabase}.
 *
 * Accepts the `sql` tagged-template function from `drizzle-orm` as the
 * second argument so the adapter can construct parameterised queries
 * without a runtime dependency on `drizzle-orm`.
 *
 * @example
 * ```ts
 * import { sql } from 'drizzle-orm'
 * import { fromDrizzle } from 'pg-boss'
 *
 * await db.transaction(async (tx) => {
 *   await boss.send('my-queue', data, { db: fromDrizzle(tx, sql) })
 * })
 * ```
 */
export function fromDrizzle (tx: DrizzleTransactionLike, sql: DrizzleSqlTagLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      const { parts, reordered } = parsePlaceholders(text, values)
      const { strings, params } = buildQuery(parts, reordered, sql)
      return unwrapSQLResult(await tx.execute(sql(strings, ...params)))
    }
  }
}

// A parameter cast to an array type (`$N::uuid[]`) is expanded into an inline
// ARRAY[...] constructor of scalar parameters rather than bound whole.
//
// Binding the array whole (sql.param([a, b])) is what postgres wants, and it is
// what node-postgres and postgres-js do, but Bun's SQL client cannot encode a JS
// array: it stringifies it to `a,b`, and every `= ANY($N::uuid[])` in pg-boss then
// fails with `malformed array literal` (oven-sh/bun#18775). Letting drizzle expand
// the array on its own is no better - it emits a bare `$2, $3` list, which is not
// valid where the statement expects one array expression.
//
// ARRAY[$2, $3] is valid everywhere a single array parameter was, keeps every
// element a real bind parameter (so no value is ever escaped into SQL text), and
// carries no driver-specific knowledge.
//
// The array cast is what makes the rewrite safe to apply, so it is required rather
// than assumed (see ARRAY_CAST).
function buildQuery (parts: string[], values: unknown[], sql: DrizzleSqlTagLike) {
  const literals: string[] = []
  const params: unknown[] = []
  let pending = parts[0]!

  for (let i = 0; i < values.length; i++) {
    const value = values[i]

    if (Array.isArray(value) && ARRAY_CAST.test(parts[i + 1]!)) {
      // ARRAY[] alone has no element type; the cast that qualified this parameter
      // for the rewrite is what resolves it.
      pending += 'ARRAY['

      for (let element = 0; element < value.length; element++) {
        literals.push(pending)
        params.push(sql.param(value[element]))
        pending = element === value.length - 1 ? '' : ','
      }

      pending += ']' + parts[i + 1]!
      continue
    }

    literals.push(pending)
    params.push(sql.param(value))
    pending = parts[i + 1]!
  }

  literals.push(pending)
  const strings = Object.assign(literals, { raw: [...literals] }) as unknown as TemplateStringsArray

  return { strings, params }
}
