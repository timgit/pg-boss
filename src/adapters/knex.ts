import type { IDatabase } from '../types.ts'
import { parsePlaceholders } from './placeholders.ts'
import { unwrapSQLResult } from '../tools.ts'

export interface KnexTransactionLike {
  raw<T = any>(sql: string, bindings?: readonly unknown[]): Promise<{ rows: T[] } | { rows: any[] }[]>
}

export function fromKnex (trx: KnexTransactionLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      // pg-boss emits $1, $2, … placeholders; knex.raw() expects ? per binding,
      // so each textual occurrence (including reuse of the same $N) must be
      // mapped to its own ? with the value duplicated in textual order.
      const { parts, reordered } = parsePlaceholders(text, values)
      // Several pg-boss queries (e.g. updateJob) also contain literal jsonb `?` key-exists
      // operators. knex.raw() scans the whole string for `?` to fill bindings, so those
      // literal occurrences must be escaped as `\?` (knex's own literal-? syntax) before
      // joining in the real placeholders — otherwise knex miscounts bindings and throws
      // "Undefined binding(s) detected" on any query that mixes both.
      const knexSql = parts.map(part => part.replace(/\?/g, '\\?')).join('?')
      return unwrapSQLResult(await trx.raw(knexSql, reordered))
    }
  }
}
