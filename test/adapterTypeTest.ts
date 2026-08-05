import { describe, it, expectTypeOf } from 'vitest'

import { fromBunSql, fromBunSqlite } from '../src/adapters/index.ts'
import type { BunSqlLike, BunSqliteLike } from '../src/adapters/index.ts'
import type { IDatabase } from '../src/types.ts'

import type { SQL } from 'bun'

// Vitest typecheck verifies these at compile time.
// A failure means our adapter interfaces have drifted from the real library types.

describe('adapter type compatibility', () => {
  it('bun sql client satisfies BunSqlLike', () => {
    expectTypeOf<SQL>().toMatchTypeOf<BunSqlLike>()
  })

  it('fromBunSql returns IDatabase', () => {
    expectTypeOf(fromBunSql).returns.toMatchTypeOf<IDatabase>()
  })

  it('bun sql client satisfies BunSqliteLike', () => {
    expectTypeOf<SQL>().toMatchTypeOf<BunSqliteLike>()
  })

  it('fromBunSqlite returns IDatabase with withTransaction', () => {
    expectTypeOf(fromBunSqlite).returns.toMatchTypeOf<IDatabase>()
    expectTypeOf(fromBunSqlite).returns.toHaveProperty('withTransaction')
  })
})
