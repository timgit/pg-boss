import { describe, it, expectTypeOf } from 'vitest'

import { fromBunSql } from '../src/adapters/index.ts'
import type { BunSqlLike } from '../src/adapters/index.ts'
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
})
