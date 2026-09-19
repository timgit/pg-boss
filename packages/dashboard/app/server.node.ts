import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from './server'
import { resolveBasePath } from './lib/base-path'
import pkg from '../package.json' with { type: 'json' }

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

const app = createHonoApp({ build, mode: 'production', serveStaticAssets: true, clientRoot, basePath })

serve({ fetch: app.fetch, port, hostname }, (info) => {
  // Named from the manifest rather than hardcoded: this bundle is repackaged under
  // other names, and a build that announces itself as something else is confusing.
  console.log(`${pkg.name}@${pkg.version} listening on http://${hostname}:${info.port}`)
  const servedUnder = basePath ? resolveBasePath(basePath).routerBasename : build.basename
  if (servedUnder && servedUnder !== '/') {
    console.log(`base path: ${servedUnder}`)
  }
})
