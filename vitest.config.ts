import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 10000,
    hookTimeout: 10000,
    include: ['test/**/*Test.ts'],
    setupFiles: ['./test/hooks.ts'],
    globals: true,
    maxWorkers: 1,
    minWorkers: 1,
    coverage: {
      reporter: ['lcov', 'text-summary', 'text'],
      include: ['src/**/*.ts']
    }
  }
})
