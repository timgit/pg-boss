import type PgBoss from '../src/index.ts'
import type { ConstructorOptions } from '../src/types.ts'

// Extend Mocha's interfaces to include custom properties directly on 'this'
// Both Context and Test need to be augmented since Context extends Test
declare module 'mocha' {
  interface Context {
    boss?: PgBoss
    bossConfig: ConstructorOptions & { schema: string }
    schema: string
  }

  interface Test {
    boss?: PgBoss
    bossConfig: ConstructorOptions & { schema: string }
    schema: string
  }
}
