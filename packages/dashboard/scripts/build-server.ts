import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proServerAlias } from '../app/lib/pro-overlay.ts'

/**
 * Bundles the two Hono entry points: `build/server.js`, which the standalone
 * server runs, and `build/handler.js`, which a host application mounts.
 *
 * A script rather than lines in `package.json` because of one flag:
 * `~pro-server` resolves to the Pro overlay's Hono half in a Pro build and to the
 * stub in every other, and only `proServerAlias()` knows which. esbuild has to be
 * told, the same way `vite.config.ts` tells Vite about `~pro`.
 *
 * **Both entry points go through here, and that is not tidiness.** Either one
 * built by a bare esbuild invocation would have no `~pro-server` alias, so it
 * could not resolve the overlay even where one exists — and the failure is
 * silent, because the stub is a valid module. An entry point that reaches
 * `createHonoApp` without an overlay serves a Pro build with none of Pro's
 * authentication. Adding a third entry point means adding it to this list, not
 * adding another line to `package.json`.
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
      '~pro-server': proServerAlias(),
    },
  })
}
