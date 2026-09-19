import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router'
import type { Context } from 'hono'
import { configureAuth } from './lib/auth.server'
import { configureReadOnly } from './lib/read-only.server'
import { getDatabaseConfigs, findDatabaseById, type DatabaseConfig } from './lib/config.server'
import { dbContext } from './lib/db-context'
import type { ProServerOverlay } from './lib/pro-contract'
import { renderManifestSource, withBasePath } from './lib/runtime-base-path'

// Resolve the per-request load context the loaders/actions rely on. The selected
// database comes from the `?db=` query param or the `pgboss_db` cookie, falling back
// to the first configured database. With `v8_middleware` on, loaders read these
// values via `context.get(dbContext)`.
//
// Exported for the tests, which assert the overlay hook runs last. Nothing else
// should call it.
export function getLoadContext (
  c: Context,
  databases: DatabaseConfig[],
  overlay: ProServerOverlay | null = null
): RouterContextProvider {
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

  // Last, so the overlay can narrow what was just chosen as well as add to it —
  // a viewer scoped to one database has to be able to override `currentDb`, not
  // merely to observe that the free default disagreed with them.
  overlay?.loadContext?.(c, context)

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
  /** Apply PGBOSS_DASHBOARD_AUTH_*. Off when embedded: the host authenticates. */
  auth?: boolean;
  /** Hosts (`host[:port]`, `*.example.com`) a form may be submitted from when a proxy hides the public origin. */
  allowedActionOrigins?: string[];
  /**
   * The Pro overlay's server half, from `loadProServer()`, or `null` for a free
   * build — which is the only shape this package is ever tested against on its
   * own.
   *
   * Required, with no default, and that is the whole point. An entry point that
   * forgets it would serve a Pro build with none of Pro's authentication: no
   * session gate, no capability narrowing, every loader answering an anonymous
   * request. A default of `null` makes that a silent hole; requiring the field
   * makes it a compile error in the one place it can be introduced.
   */
  overlay: ProServerOverlay | null;
}

export function createHonoApp ({
  build: givenBuild,
  mode,
  serveStaticAssets = false,
  clientRoot = './build/client',
  databases,
  basePath,
  auth = true,
  allowedActionOrigins,
  overlay,
}: CreateHonoAppOptions): Hono {
  const app = new Hono()
  const rehomed = typeof givenBuild === 'function' ? givenBuild : withBasePath(givenBuild, basePath)
  const build = typeof rehomed === 'function' || !allowedActionOrigins
    ? rehomed
    : { ...rehomed, allowedActionOrigins }
  const mountPath = typeof build !== 'function' && build.basename && build.basename !== '/' ? build.basename : ''

  if (mountPath) {
    // `${mountPath}.data` is the index route's data request: a sibling of the mount path.
    app.use('*', async (c, next) => {
      const { pathname } = new URL(c.req.url)
      const ours = pathname === mountPath || pathname === `${mountPath}.data` || pathname.startsWith(`${mountPath}/`)

      return ours ? next() : c.text('Not Found', 404)
    })
  }

  // Precedence between the authentication schemes, decided once.
  //
  // Hono dispatches in registration order, so this ordering *is* the rule: a
  // route registered before `app.use(basicAuth)` answers without ever reaching
  // it. An overlay that does not authenticate must therefore be registered
  // after the gate, or mounting Pro would quietly open a hole in a dashboard
  // that was password-protected the day before.
  //
  // Whichever branch runs, a credential the operator configured is never
  // discarded in silence. There are two ways to end up ignoring one — an overlay
  // that authenticates instead, or a host that says it will — and both say so on
  // stdout. An operator who set a password and is not being asked for one needs
  // to hear that from us rather than discover it.
  const configuredCredential = Boolean(
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME || process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD
  )

  if (overlay?.ownsAuth) {
    // An overlay that authenticates replaces the shared credential rather than
    // sitting behind it: stacking them prompts twice for two unrelated logins,
    // and the browser's Basic dialog is the one with no way to sign out. It goes
    // first because its own login route has to answer someone who is by
    // definition not authenticated yet.
    if (configuredCredential) {
      console.log('PGBOSS_DASHBOARD_AUTH_* ignored: the Pro overlay provides authentication.')
    }

    overlay.server?.(app)
  } else {
    // Basic auth (no-op unless PGBOSS_DASHBOARD_AUTH_* are set). Runs before the
    // handler so static assets and SSR responses are both gated — and before the
    // overlay, so anything it adds is gated too.
    if (auth) {
      configureAuth(app)
    } else if (configuredCredential) {
      console.log(
        'PGBOSS_DASHBOARD_AUTH_* ignored: this dashboard is mounted inside a host ' +
        'application, which is responsible for authenticating the request.'
      )
    }

    overlay?.server?.(app)
  }

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
    if (typeof build !== 'function' && rehomed !== givenBuild) {
      const manifestSource = renderManifestSource(build)

      app.get(build.assets.url, (c) => c.body(manifestSource, 200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      }))
    }

    app.use(`${basename}/assets/*`, async (c, next) => {
      await next()
      if (c.res.ok) {
        c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      }
    })
    app.use(`${basename}/assets/*`, serveStatic({ root: clientRoot, rewriteRequestPath }))
    // Remaining public files (favicon, etc.); misses fall through to the SSR handler.
    app.use('*', serveStatic({ root: clientRoot, rewriteRequestPath }))
  }

  const productionHandler = typeof build === 'function' ? undefined : createRequestHandler(build, mode)

  app.all('*', async (c) => {
    const handler = productionHandler ?? createRequestHandler(await (build as () => ServerBuild | Promise<ServerBuild>)(), mode)
    const response = await handler(c.req.raw, getLoadContext(c, databases ?? getDatabaseConfigs(), overlay))

    // Pages carry job payloads.
    if (!response.headers.has('Cache-Control')) {
      response.headers.set('Cache-Control', 'no-store')
    }
    return response
  })

  return app
}
