import { defineConfig } from 'vitest/config'

const slowBackends = ['cockroachdb', 'yugabytedb', 'pglite', 'citus']
const isSlowBackend = slowBackends.includes(process.env.DB_TYPE ?? '')
const testTimeout = isSlowBackend ? 120000 : 30000
const hookTimeout = isSlowBackend ? 120000 : 30000

export default defineConfig({
  test: {
    testTimeout,
    hookTimeout,
    include: ['test/**/*Test.ts'],
    globalSetup: ['./test/checkDuplicateTestNames.ts'],
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
