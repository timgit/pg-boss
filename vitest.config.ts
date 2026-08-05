import { defineConfig } from 'vitest/config'

const testTimeout = 120000
const hookTimeout = 120000

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
      include: ['src/**/*.ts']
    }
  }
})
