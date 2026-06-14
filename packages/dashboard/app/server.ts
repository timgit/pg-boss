import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router'
import type { Context } from 'hono'
import { configureAuth } from './lib/auth.server'
import { getDatabaseConfigs, findDatabaseById } from './lib/config.server'
import { dbContext } from './lib/db-context'

// Resolve the per-request load context the loaders/actions rely on. The selected
// database comes from the `?db=` query param or the `pgboss_db` cookie, falling back
// to the first configured database. With `v8_middleware` on, loaders read these
// values via `context.get(dbContext)`.
function getLoadContext (c: Context): RouterContextProvider {
  const databases = getDatabaseConfigs()

  const url = new URL(c.req.url)
  const dbId = url.searchParams.get('db') || c.req.header('cookie')?.match(/pgboss_db=([^;]+)/)?.[1] || null
  const currentDb = findDatabaseById(databases, dbId) || databases[0]

  const context = new RouterContextProvider()
  context.set(dbContext, {
    databases,
    currentDb,
    // Backwards-compatible accessors
    DB_URL: currentDb?.url || 'postgres://localhost/pgboss',
    SCHEMA: currentDb?.schema || 'pgboss',
  })
  return context
}

export interface CreateHonoAppOptions {
  /**
   * The React Router server build, or a function returning it. In production the
   * concrete build is passed; in development a function is passed so the build can be
   * re-fetched per request (picking up HMR updates).
   */
  build: ServerBuild | (() => ServerBuild | Promise<ServerBuild>);
  mode: 'development' | 'production';
  /**
   * Serve built client assets from `build/client`. Enabled in production; in development
   * the Vite dev server middleware serves assets instead.
   */
  serveStaticAssets?: boolean;
}

export function createHonoApp ({ build, mode, serveStaticAssets = false }: CreateHonoAppOptions): Hono {
  const app = new Hono()

  // Basic auth (no-op unless PGBOSS_DASHBOARD_AUTH_* are set). Runs first so static
  // assets and SSR responses are both gated.
  configureAuth(app)

  if (serveStaticAssets) {
    // The build's own basename is the single source of truth (baked by
    // react-router.config.ts at build time). When set, the browser requests assets at
    // `${basename}/assets/*` while the files live at `build/client/assets/*`, so strip
    // the prefix before the filesystem lookup.
    const basename = typeof build !== 'function' && build.basename && build.basename !== '/'
      ? build.basename
      : ''
    const rewriteRequestPath = basename
      ? (path: string) => path.slice(basename.length)
      : undefined

    app.use(`${basename}/assets/*`, serveStatic({ root: './build/client', rewriteRequestPath }))
    // Remaining public files (favicon, etc.); misses fall through to the SSR handler.
    app.use('*', serveStatic({ root: './build/client', rewriteRequestPath }))
  }

  app.all('*', async (c) => {
    const resolvedBuild = typeof build === 'function' ? await build() : build
    const handler = createRequestHandler(resolvedBuild, mode)
    return handler(c.req.raw, getLoadContext(c))
  })

  return app
}
