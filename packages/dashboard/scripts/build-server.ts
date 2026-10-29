import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Bundles the two Hono entry points: `build/server.js`, which the standalone
 * server runs, and `build/handler.js`, which a host application mounts.
 *
 * Neither bundles the Pro overlay. Both read its server half from the React
 * Router build at runtime (`serverOverlayOf()`), where `app/entry.server.tsx`
 * exports it, so the overlay's hook shares one module graph with the routes.
 * Anything imported from here is a second copy with its own module state, which
 * is why `dbContext` pins its token on globalThis.
 *
 * `react-router build` emits the route modules; this emits the servers that serve
 * them. Both halves of `npm run build`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ENTRY_POINTS = [
  { entry: 'app/server.node.ts', outfile: 'build/server.js' },
  { entry: 'app/handler.ts', outfile: 'build/handler.js' },
]

for (const { entry, outfile } of ENTRY_POINTS) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    platform: 'node',
    format: 'esm',
    // Dependencies stay external and are resolved from node_modules at runtime, so
    // the bundle carries this package's own code and nothing else.
    packages: 'external',
    alias: {
      '~': resolve(root, 'app'),
    },
  })
}
