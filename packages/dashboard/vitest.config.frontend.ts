import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/frontend/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['app/components/**/*.{ts,tsx}'],
      exclude: [
        'app/**/*.d.ts',
        // React-aria wrappers and components requiring complex mocking
        // These are better tested via e2e tests
        'app/components/loading-bar.tsx',
        'app/components/ui/confirm-dialog.tsx',
        'app/components/ui/select.tsx',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
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
