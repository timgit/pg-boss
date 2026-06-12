import { serve } from '@hono/node-server'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from './server'

// The React Router server build is emitted by `react-router build` as a sibling of this
// bundle (`build/server/index.js`). It does not exist at type-check time and must be
// loaded at runtime rather than bundled, so the specifier is kept non-literal — esbuild
// leaves it as a runtime `import()` and tsc does not try to resolve it.
const buildModulePath = './server/index.js'
const build = (await import(buildModulePath)) as unknown as ServerBuild

const port = Number(process.env.PORT) || 3000
const hostname = process.env.HOST || '0.0.0.0'

const app = createHonoApp({ build, mode: 'production', serveStaticAssets: true })

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`pg-boss dashboard listening on http://${hostname}:${info.port}`)
  if (build.basename && build.basename !== '/') {
    console.log(`base path: ${build.basename}`)
  }
})
