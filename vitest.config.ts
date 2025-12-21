import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 10000,
    hookTimeout: 10000,
    include: ['test/**/*Test.ts'],
    setupFiles: ['./test/hooks.ts'],
    globals: true,
    coverage: {
      reporter: ['lcov', 'text-summary', 'text'],
      include: ['src/**/*.ts']
    }
  }
})
