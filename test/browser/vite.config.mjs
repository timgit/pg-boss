import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default {
  // Serve from the repo root so the harness imports src/adapters/pglite.ts directly — no build step,
  // and whatever is checked out is what gets tested.
  root: resolve(here, '../..'),
  // PGlite ships its own wasm and filesystem assets and must not be pre-bundled.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  server: {
    port: 5199,
    open: '/test/browser/index.html',
    // The harness is edited and re-run by hand; without this the browser serves the previous module
    // out of its cache and you debug a file that is no longer on disk.
    headers: { 'Cache-Control': 'no-store' }
  }
}
