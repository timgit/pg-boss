import { defineConfig } from 'vitest/config'
import { isDistributedBackend, distributedTimeout, postgresTimeout } from './test/timeouts.ts'

// See test/timeouts.ts for why a distributed backend gets a budget of its own.
const timeout = isDistributedBackend ? distributedTimeout : postgresTimeout

export default defineConfig({
  test: {
    testTimeout: timeout,
    hookTimeout: timeout,
    include: ['test/**/*Test.ts'],
    globalSetup: ['./test/checkDuplicateTestNames.ts'],
    setupFiles: ['./test/bindAudit.ts', './test/hooks.ts'],
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
