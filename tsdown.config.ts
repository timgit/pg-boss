import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  format: 'es',
  dts: true,
  exports: true,
  noExternal: ['serialize-error'],
  unbundle: true
})
