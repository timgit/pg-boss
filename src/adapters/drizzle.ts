import type { IDatabase } from '../types.ts'
import { parsePlaceholders } from './placeholders.ts'

export interface DrizzleTransactionLike {
  execute(query: unknown): Promise<{ rows: any[] }>
}

export interface DrizzleSqlTagLike {
  (strings: TemplateStringsArray, ...values: unknown[]): unknown
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
      const strings = Object.assign([...parts], { raw: [...parts] }) as TemplateStringsArray
      return tx.execute(sql(strings, ...reordered))
    }
  }
}
