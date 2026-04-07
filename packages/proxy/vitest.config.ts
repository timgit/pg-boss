import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*Test.ts'],
    typecheck: {
      enabled: true,
      include: ['test/**/*Test.ts'],
    },
  },
})
