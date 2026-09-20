import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from './server'
import { serverOverlay } from '~pro-server'
import { resolveBasePath } from './lib/base-path'

/**
 * The manifest sitting beside this bundle, read when the server starts.
 *
 * Not `import pkg from '../package.json'`: that is resolved when the bundle is
 * *built*, which bakes in the name it was built under. @pg-boss/pro ships this
 * exact server under its own name, so the import made a Pro install announce
 * itself as the free dashboard — the one thing this line exists to avoid.
 *
 * Unreadable is not fatal. A missing manifest says nothing about whether the
 * dashboard can serve requests, and refusing to start over a log line would be
 * a poor trade.
 */
function manifest (): { name?: string, version?: string } {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  } catch {
    return {}
  }
}

const pkg = manifest()

// The React Router server build is emitted by `react-router build` as a sibling of this
// bundle (`build/server/index.js`). It does not exist at type-check time and must be
// loaded at runtime rather than bundled, so the specifier is kept non-literal — esbuild
// leaves it as a runtime `import()` and tsc does not try to resolve it.
const buildModulePath = './server/index.js'
const build = (await import(buildModulePath)) as unknown as ServerBuild

const port = Number(process.env.PORT) || 3000
const hostname = process.env.HOST || '0.0.0.0'

// Read at runtime, so the prebuilt package can be served under a sub-path without a rebuild.
const basePath = process.env.PGBOSS_DASHBOARD_BASE_PATH || undefined

// Relative to this file, not the working directory, so the server can be started from anywhere.
const clientRoot = fileURLToPath(new URL('./client', import.meta.url))

// `~pro-server` is the empty stub in every build but a Pro one, so this is the
// free dashboard unchanged: an object with no hooks on it.
const app = createHonoApp({
  build,
  mode: 'production',
  serveStaticAssets: true,
  clientRoot,
  basePath,
  overlay: serverOverlay,
})

serve({ fetch: app.fetch, port, hostname }, (info) => {
  // Named from the manifest rather than hardcoded: this bundle is repackaged under
  // other names, and a build that announces itself as something else is confusing.
  const named = pkg.name ? `${pkg.name}@${pkg.version} ` : ''

  console.log(`${named}listening on http://${hostname}:${info.port}`)
  const servedUnder = basePath ? resolveBasePath(basePath).routerBasename : build.basename
  if (servedUnder && servedUnder !== '/') {
    console.log(`base path: ${servedUnder}`)
  }
})
