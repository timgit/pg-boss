import { describe, it, expectTypeOf } from 'vitest'

import { fromKnex, fromKysely, fromDrizzle, fromPrisma } from '../src/adapters/index.ts'
import type {
  KnexTransactionLike,
  KyselyTransactionLike,
  DrizzleTransactionLike,
  DrizzleSqlTagLike,
  PrismaTransactionLike
} from '../src/adapters/index.ts'
import type { IDatabase } from '../src/types.ts'

import type { Knex } from 'knex'
import type { Transaction as KyselyTransaction } from 'kysely'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { sql as drizzleSqlType } from 'drizzle-orm'
import type { PrismaClient } from '@prisma/client'

// Vitest typecheck verifies these at compile time.
// A failure means our adapter interfaces have drifted from the real library types.

describe('adapter type compatibility', () => {
  it('knex transaction satisfies KnexTransactionLike', () => {
    expectTypeOf<Knex.Transaction>().toMatchTypeOf<KnexTransactionLike>()
  })

  it('kysely transaction satisfies KyselyTransactionLike', () => {
    expectTypeOf<KyselyTransaction<any>>().toMatchTypeOf<KyselyTransactionLike>()
  })

  it('drizzle tx satisfies DrizzleTransactionLike', () => {
    expectTypeOf<NodePgDatabase>().toMatchTypeOf<DrizzleTransactionLike>()
  })

  it('drizzle sql satisfies DrizzleSqlTagLike', () => {
    expectTypeOf<typeof drizzleSqlType>().toMatchTypeOf<DrizzleSqlTagLike>()
  })

  it('prisma client satisfies PrismaTransactionLike', () => {
    expectTypeOf<PrismaClient>().toMatchTypeOf<PrismaTransactionLike>()
  })

  it('fromKnex returns IDatabase', () => {
    expectTypeOf(fromKnex).returns.toMatchTypeOf<IDatabase>()
  })

  it('fromKysely returns IDatabase', () => {
    expectTypeOf(fromKysely).returns.toMatchTypeOf<IDatabase>()
  })

  it('fromDrizzle returns IDatabase', () => {
    expectTypeOf(fromDrizzle).returns.toMatchTypeOf<IDatabase>()
  })

  it('fromPrisma returns IDatabase', () => {
    expectTypeOf(fromPrisma).returns.toMatchTypeOf<IDatabase>()
  })
})
