import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/db/setup.ts'],
    include: ['tests/db/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run database tests sequentially to avoid conflicts
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, './app'),
    },
  },
})
