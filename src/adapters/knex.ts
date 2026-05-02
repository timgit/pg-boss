import type { IDatabase } from '../types.ts'
import { parsePlaceholders } from './placeholders.ts'

export interface KnexTransactionLike {
  raw<T = any>(sql: string, bindings?: readonly unknown[]): Promise<{ rows: T[] }>
}

export function fromKnex (trx: KnexTransactionLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      // pg-boss emits $1, $2, … placeholders; knex.raw() expects ? per binding,
      // so each textual occurrence (including reuse of the same $N) must be
      // mapped to its own ? with the value duplicated in textual order.
      const { parts, reordered } = parsePlaceholders(text, values)
      const knexSql = parts.join('?')
      const result = await trx.raw(knexSql, reordered)
      return { rows: result.rows }
    }
  }
}
