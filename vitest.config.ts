import { defineConfig } from 'vitest/config'

// CockroachDB pays ~8-19s of online-DDL/schema rebuild per test, which blows the PostgreSQL-tuned
// 10s budget. Give the whole suite more headroom when running against CockroachDB so the
// full-suite compatibility run reports real failures instead of timeouts.
const isCockroachDb = process.env.DB_TYPE === 'cockroachdb'
const testTimeout = isCockroachDb ? 60000 : 10000
const hookTimeout = isCockroachDb ? 60000 : 10000

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
