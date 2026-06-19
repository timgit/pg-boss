import { defineConfig } from 'vitest/config'

// CockroachDB and YugabyteDB pay heavy online-DDL/schema-rebuild costs per test, which blow the
// PostgreSQL-tuned 10s budget. Give the whole suite more headroom when running against a distributed
// backend so the compatibility runs report real failures instead of timeouts.
const isDistributedBackend = process.env.DB_TYPE === 'cockroachdb' || process.env.DB_TYPE === 'yugabytedb'
const testTimeout = isDistributedBackend ? 60000 : 10000
const hookTimeout = isDistributedBackend ? 60000 : 10000

export default defineConfig({
  test: {
    testTimeout,
    hookTimeout,
    include: ['test/**/*Test.ts'],
    setupFiles: ['./test/hooks.ts'],
    globals: true,
    typecheck: {
      enabled: true,
      include: ['test/**/*TypeTest.ts'],
      tsconfig: './tsconfig.typecheck.json'
    },
    coverage: {
      reporter: ['lcov', 'text-summary', 'text'],
      include: ['src/**/*.ts'],
      // cli.ts is tested via subprocess execution (child_process.exec), which runs
      // in a separate Node.js process not instrumented by vitest's coverage tools
      exclude: ['src/cli.ts']
    }
  }
})
