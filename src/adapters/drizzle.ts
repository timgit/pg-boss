import type { IDatabase } from '../types.ts'

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
      if (!values || values.length === 0) {
        const strings = Object.assign([text], { raw: [text] }) as TemplateStringsArray
        return tx.execute(sql(strings))
      }

      // Split on $1, $2, … to get the literal parts, then call sql
      // as a tagged template with those parts and the values.
      const parts = text.split(/\$\d+/)
      const strings = Object.assign([...parts], { raw: [...parts] }) as TemplateStringsArray
      return tx.execute(sql(strings, ...values))
    }
  }
}
