import { defineConfig } from 'tsdown'

const entry = ['./src/index.ts']

export default defineConfig([
  {
    entry,
    format: 'es',
    dts: true,
    outExtensions: () => ({ js: '.mjs', dts: '.d.ts' })
  },
  {
    entry,
    format: 'cjs',
    dts: true,
    clean: false,
    // Bundle the ESM-only dependency so CommonJS consumers can import pg-boss.
    noExternal: ['serialize-error'],
    outExtensions: () => ({ js: '.cjs', dts: '.d.cts' })
  }
])
