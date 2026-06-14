import type { IDatabase } from '../types.ts'

export interface PrismaTransactionLike {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>
}

export function fromPrisma (tx: PrismaTransactionLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      const rows = await tx.$queryRawUnsafe(text, ...(values ?? []))
      // v8 ignore next
      return { rows: Array.isArray(rows) ? rows : [] }
    }
  }
}
