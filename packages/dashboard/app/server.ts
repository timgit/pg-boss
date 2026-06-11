import { createHonoServer } from 'react-router-hono-server/node'
import { serveStatic } from '@hono/node-server/serve-static'
import { configureAuth } from './lib/auth.server'
import { getDatabaseConfigs, findDatabaseById, type DatabaseConfig } from './lib/config.server'
import { resolveBasePath } from './lib/base-path'

declare module 'react-router' {
  interface AppLoadContext {
    readonly databases: DatabaseConfig[];
    readonly currentDb: DatabaseConfig;
    // Convenience accessors for current database
    readonly DB_URL: string;
    readonly SCHEMA: string;
  }
}

// react-router-hono-server serves built client assets from `/assets/*` at the root,
// ignoring the React Router basename. When a basename is set the HTML references
// `${basename}/assets/*` (Vite base), so we mount a matching static handler here.
// beforeAll runs before the library's own static middleware, so this wins.
//
// PGBOSS_DASHBOARD_BASE_PATH is inlined at build time by Vite `define`, so the
// basename is baked into the bundle and does not need to be set at runtime.
const isProduction = process.env.NODE_ENV !== 'development'
const { routerBasename } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)

export default createHonoServer({
  beforeAll (app) {
    // Configure auth first so basic auth runs before the static asset handler
    // below. serveStatic responds without calling next(), so mounting it ahead
    // of configureAuth would leave prefixed assets publicly accessible while the
    // library's root /assets/* stays auth-gated — keep the two consistent.
    configureAuth(app)
    if (isProduction && routerBasename !== '/') {
      app.use(
        `${routerBasename}/assets/*`,
        serveStatic({
          root: 'build/client',
          rewriteRequestPath: (path) => path.slice(routerBasename.length),
        })
      )
    }
  },
  getLoadContext (c) {
    const databases = getDatabaseConfigs()

    // Get selected database from query param or cookie
    const url = new URL(c.req.url)
    const dbId = url.searchParams.get('db') || c.req.header('cookie')?.match(/pgboss_db=([^;]+)/)?.[1] || null
    const currentDb = findDatabaseById(databases, dbId) || databases[0]

    return {
      databases,
      currentDb,
      // Backwards-compatible accessors
      DB_URL: currentDb?.url || 'postgres://localhost/pgboss',
      SCHEMA: currentDb?.schema || 'pgboss',
    }
  },
})
