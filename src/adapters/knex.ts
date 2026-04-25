import type { IDatabase } from '../types.ts'

export interface KnexTransactionLike {
  raw<T = any>(sql: string, bindings?: readonly unknown[]): Promise<{ rows: T[] }>
}

export function fromKnex (trx: KnexTransactionLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      // pg-boss emits $1, $2, … placeholders; knex.raw() expects ?
      const knexSql = text.replace(/\$(\d+)/g, '?')
      const result = await trx.raw(knexSql, values as readonly unknown[])
      return { rows: result.rows }
    }
  }
}
