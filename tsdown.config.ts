import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['es', 'cjs'],
  dts: true,
  outExtensions: ({ format }) => {
    if (format === 'cjs') {
      return { js: '.cjs', dts: '.d.cts' }
    }

    return { js: '.mjs', dts: '.d.ts' }
  }
})
