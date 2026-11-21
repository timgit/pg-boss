import type { IDatabase } from '../types.ts'

export interface PrismaTransactionLike {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>
}

/**
 * Wraps a Prisma transaction as an {@link IDatabase} for scoping job operations inside an existing transaction.
 *
 * Use as the per-call `db` option, not as the constructor `db` while `migrate` or `supervise` is on, since Prisma rejects a multi-statement query.
 *
 * @see https://pgboss.io/api/adapters#prisma
 */
export function fromPrisma (tx: PrismaTransactionLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      const rows = await tx.$queryRawUnsafe(text, ...(values ?? []))
      // v8 ignore next
      return { rows: Array.isArray(rows) ? rows : [] }
    }
  }
}
