import type { IDatabase } from '../types.ts'

export interface KyselyTransactionLike {
  executeQuery<R>(query: {
    readonly sql: string
    readonly parameters: ReadonlyArray<unknown>
    readonly query: any
    readonly queryId: { readonly queryId: string }
  }, queryId?: unknown): Promise<{ readonly rows: R[] }>
}

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
