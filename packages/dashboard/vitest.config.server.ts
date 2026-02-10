import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/server/helpers.ts'],
    include: ['tests/server/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run server tests sequentially to avoid database conflicts
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['app/lib/**/*.ts'],
      exclude: [
        'app/**/*.d.ts',
        'app/lib/types.ts',        // Type definitions only
        'app/lib/config.server.ts', // Config parsing, tested via integration
      ],
      thresholds: {
        lines: 90,
        functions: 85,
        branches: 85,
        statements: 90,
      },
    },
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, './app'),
      'pg-boss': resolve(__dirname, '../../src'),
    },
  },
})
