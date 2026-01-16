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
      include: ['src/**/*.ts'],
      // cli.ts is tested via subprocess execution (child_process.exec), which runs
      // in a separate Node.js process not instrumented by vitest's coverage tools
      exclude: ['src/cli.ts']
    }
  }
})
