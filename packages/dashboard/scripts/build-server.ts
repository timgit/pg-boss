import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proServerAlias } from '../app/lib/pro-overlay.ts'

/**
 * Bundles the Hono server entry to `build/server.js`.
 *
 * A script rather than a line in `package.json` because of one flag: `~pro-server`
 * resolves to the Pro overlay's Hono half in a Pro build and to the stub in every
 * other, and only `proServerAlias()` knows which. esbuild has to be told, the same
 * way `vite.config.ts` tells Vite about `~pro`.
 *
 * `react-router build` emits the route modules; this emits the server that serves
 * them. Both halves of `npm run build`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [resolve(root, 'app/server.node.ts')],
  outfile: resolve(root, 'build/server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Dependencies stay external and are resolved from node_modules at runtime, so
  // the bundle carries this package's own code and nothing else.
  packages: 'external',
  alias: {
    '~': resolve(root, 'app'),
    '~pro-server': proServerAlias(),
  },
})
