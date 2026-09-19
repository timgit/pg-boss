import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router'
import type { Context } from 'hono'
import { configureAuth } from './lib/auth.server'
import { configureReadOnly } from './lib/read-only.server'
import { getDatabaseConfigs, findDatabaseById, type DatabaseConfig } from './lib/config.server'
import { dbContext } from './lib/db-context'
import { renderManifestSource, withBasePath } from './lib/runtime-base-path'

// Resolve the per-request load context the loaders/actions rely on. The selected
// database comes from the `?db=` query param or the `pgboss_db` cookie, falling back
// to the first configured database. With `v8_middleware` on, loaders read these
// values via `context.get(dbContext)`.
function getLoadContext (c: Context, databases: DatabaseConfig[]): RouterContextProvider {
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
  /** Where the built client assets live. Defaults to `./build/client`, relative to the cwd. */
  clientRoot?: string;
  /** Defaults to the databases described by DATABASE_URL / PGBOSS_SCHEMA. */
  databases?: DatabaseConfig[];
  /** Overrides the base path baked into the build. Production builds only. */
  basePath?: string;
}

export function createHonoApp ({
  build: givenBuild,
  mode,
  serveStaticAssets = false,
  clientRoot = './build/client',
  databases,
  basePath,
}: CreateHonoAppOptions): Hono {
  const app = new Hono()
  const build = typeof givenBuild === 'function' ? givenBuild : withBasePath(givenBuild, basePath)

  // Basic auth (no-op unless PGBOSS_DASHBOARD_AUTH_* are set). Runs first so static
  // assets and SSR responses are both gated.
  configureAuth(app)

  // Read-only mode (no-op unless PGBOSS_DASHBOARD_READ_ONLY=1). Runs after auth so a
  // rejected mutation still requires credentials to provoke, and before the SSR
  // handler so every route action is covered by one check.
  configureReadOnly(app)

  if (serveStaticAssets) {
    // The build's own basename is the single source of truth (baked by
    // react-router.config.ts at build time). When set, the browser requests assets at
    // `${basename}/assets/*` while the files live at `build/client/assets/*`, so strip
    // the prefix before the filesystem lookup.
    const basename = typeof build !== 'function' && build.basename && build.basename !== '/'
      ? build.basename
      : ''
    // Only strip a prefix that is genuinely there, and only on a segment
    // boundary. A blind `slice` escapes the static root: serveStatic's traversal
    // guard runs on the *raw* path and only rejects `..` bounded by slashes, so
    // `/aaaaaaaaaaaa../server/index.js` passes it, and slicing 13 characters for
    // a basename of `/admin/queues` leaves `../server/index.js` — one level out
    // of `build/client`, into the server bundle. The catch-all below sees every
    // path, not just `${basename}/assets/*`, which is what makes it reachable.
    //
    // A path that is not under the basename is returned unchanged rather than
    // trimmed. It cannot be ours, and `join` treats what is left as an ordinary
    // segment name, so it simply misses and falls through to the SSR handler.
    const rewriteRequestPath = basename
      ? (path: string) => {
          if (path !== basename && !path.startsWith(`${basename}/`)) {
            return path
          }

          const rest = path.slice(basename.length)

          return rest.startsWith('/') ? rest : `/${rest}`
        }
      : undefined

    // The static manifest file still carries the baked asset URLs: answer with the re-homed one.
    if (typeof build !== 'function' && build !== givenBuild) {
      const manifestSource = renderManifestSource(build)

      app.get(build.assets.url, (c) => c.body(manifestSource, 200, {
        'Content-Type': 'text/javascript; charset=utf-8',
      }))
    }

    app.use(`${basename}/assets/*`, serveStatic({ root: clientRoot, rewriteRequestPath }))
    // Remaining public files (favicon, etc.); misses fall through to the SSR handler.
    app.use('*', serveStatic({ root: clientRoot, rewriteRequestPath }))
  }

  app.all('*', async (c) => {
    const resolvedBuild = typeof build === 'function' ? await build() : build
    const handler = createRequestHandler(resolvedBuild, mode)
    return handler(c.req.raw, getLoadContext(c, databases ?? getDatabaseConfigs()))
  })

  return app
}
