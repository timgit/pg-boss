import type { IDatabase } from '../types.ts'

export interface KyselyTransactionLike {
  executeQuery<R>(query: {
    readonly sql: string
    readonly parameters: ReadonlyArray<unknown>
    readonly query: any
    readonly queryId: { readonly queryId: string }
  }, queryId?: unknown): Promise<{ readonly rows: R[] }>
}

/**
 * Wraps a Kysely transaction as an {@link IDatabase} for scoping job operations inside an existing transaction.
 *
 * Use as the per-call `db` option, not as the instance `db` or with `migrate: true` because Kysely does not return rows from multi-statement queries.
 *
 * @see https://pgboss.io/api/adapters#kysely
 */
export function fromKysely (trx: KyselyTransactionLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      const result = await trx.executeQuery({
        sql: text,
        parameters: values ?? [],
        query: { kind: 'RawNode' },
        queryId: { queryId: 'pgboss' }
      })
      return { rows: [...result.rows] }
    }
  }
}
