import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from './server'
import { serverOverlay } from '~pro-server'
import { toDatabaseConfig, type DatabaseInput } from './lib/config.server'
import { withBasePath } from './lib/runtime-base-path'

export type { DatabaseInput }

export interface CreateDashboardHandlerOptions {
  /** The first one is selected by default. */
  databases: DatabaseInput[];
  /** Where the host mounts the handler, e.g. `/admin/queues`. Requests keep this prefix. */
  basePath?: string;
  /**
   * Apply `PGBOSS_DASHBOARD_AUTH_*` inside the mount as well.
   *
   * Off by default: a handler is mounted behind the host's own authentication,
   * and prompting again for a second, unrelated credential is worse than not
   * prompting. Turn it on for defence in depth, or when the host has no
   * authentication of its own to put in front.
   *
   * Either way a configured credential is never discarded in silence — leaving
   * it off with `PGBOSS_DASHBOARD_AUTH_*` set says so on stdout, because an
   * operator who set a password and is not being asked for one needs to hear it
   * from us.
   */
  auth?: boolean;
  /**
   * Hosts a form submission may come from, e.g. `ops.example.com`,
   * `ops.example.com:8443` or `*.example.com`.
   *
   * React Router refuses an action whose `Origin` header does not match the
   * request URL. Behind a proxy the host often sees `http://127.0.0.1:3000`
   * while the browser sent the public origin, so every action returns 400 while
   * every page renders — a failure that looks like a dashboard bug and is not.
   *
   * **Hosts, not origins.** `throwIfPotentialCSRFAttack` compares
   * `new URL(originHeader).host` against this list (react-router
   * `lib/actions.js:19,27`), so a scheme never matches: `https://ops.example.com`
   * is refused, `ops.example.com` is allowed. Wildcards are matched per label.
   *
   * There is no way to switch the check off. React Router coerces anything that
   * is not an array to `[]` before comparing, so a non-array value is the same
   * as omitting this.
   *
   * The usual place to set it is `react-router.config.ts`, which a host cannot
   * edit on a prebuilt package, leaving the handler as the only component that
   * can. Passing a `Request` carrying the public URL also works and needs no
   * configuration.
   */
  allowedActionOrigins?: string[];
}

export interface DashboardHandler {
  (request: Request): Promise<Response>;
  /**
   * Releases everything this handler holds: the database pools and the pg-boss
   * instances behind the write paths, whose timers otherwise keep the event
   * loop alive.
   *
   * Final. Requests after it answer 503 rather than reopening what was closed.
   */
  close (): Promise<void>;
}

const EMBEDDED_KEY = Symbol.for('pgboss.dashboard.embedded')
const CLOSE_POOLS_KEY = Symbol.for('pgboss.dashboard.closeAllPools')
const STOP_INSTANCES_KEY = Symbol.for('pgboss.dashboard.stopAllInstances')

/**
 * A Fetch API handler for the dashboard, to mount inside an existing application.
 * It loads nothing until the first request.
 *
 * It adds no authentication of its own — mount it behind whatever your host
 * application already uses. A Pro build is the exception: its overlay brings its
 * own, and this loads it, so mounting Pro here authenticates exactly as the
 * standalone server does.
 */
export function createDashboardHandler (
  { databases, basePath, allowedActionOrigins, auth = false }: CreateDashboardHandlerOptions
): DashboardHandler {
  if (databases.length === 0) {
    throw new Error('createDashboardHandler() needs at least one database')
  }

  const configs = databases.map(toDatabaseConfig)
  const duplicate = configs.find((config, index) => configs.findIndex(other => other.id === config.id) !== index)

  if (duplicate) {
    throw new Error(`Two databases resolve to the id "${duplicate.id}": give each one a distinct name`)
  }

  // Fail on a bad base path now, not on the first request.
  withBasePath({ basename: '/', publicPath: '/', assets: {} } as unknown as ServerBuild, basePath)

  let app: Promise<Hono> | undefined
  let closed = false

  const globalStore = globalThis as typeof globalThis & {
    [EMBEDDED_KEY]?: boolean
    [CLOSE_POOLS_KEY]?: () => Promise<void>
    [STOP_INSTANCES_KEY]?: () => Promise<void>
  }

  const load = async (): Promise<Hono> => {
    // db.server.ts reads this on import and leaves SIGTERM/SIGINT to the host.
    globalStore[EMBEDDED_KEY] = true

    // Non-literal so esbuild and tsc leave it as a runtime import, as in server.node.ts.
    const buildModulePath = './server/index.js'
    const loaded = (await import(buildModulePath)) as unknown as ServerBuild

    // Spread onto a copy rather than mutating the imported module, which is
    // shared: two handlers with different settings would otherwise fight over
    // one object. `withBasePath` already returns a copy the same way.
    const build = allowedActionOrigins === undefined
      ? loaded
      : { ...loaded, allowedActionOrigins }

    return createHonoApp({
      build,
      mode: 'production',
      serveStaticAssets: true,
      clientRoot: fileURLToPath(new URL('./client', import.meta.url)),
      databases: configs,
      basePath,
      // Defaults to false: the host authenticates. `createHonoApp` says so on
      // stdout when a credential was configured, rather than dropping it in
      // silence.
      auth,
      allowedActionOrigins,
      // The same overlay the standalone server loads, through the same alias.
      // `~pro-server` is the empty stub in every build but a Pro one, so this
      // adds nothing to a free build — and in a Pro build it is the difference
      // between a mounted dashboard that authenticates and one that does not.
      // A Pro overlay owns authentication, so `auth: false` above costs it
      // nothing: `createHonoApp` takes the overlay branch either way.
      // It resolves because `scripts/build-server.ts` bundles this entry point
      // with the alias; a bare esbuild invocation could not.
      overlay: serverOverlay,
    })
  }

  const handler = async (request: Request): Promise<Response> => {
    if (closed) {
      return new Response('The dashboard handler is closed', { status: 503 })
    }

    // A failed load is not cached, so the next request retries.
    app ??= load().catch((error) => {
      app = undefined
      throw error
    })

    return (await app).fetch(request)
  }

  const close = async (): Promise<void> => {
    closed = true
    // A load in flight has not published its hooks yet.
    await app?.catch(() => {})
    await globalStore[STOP_INSTANCES_KEY]?.()
    await globalStore[CLOSE_POOLS_KEY]?.()
  }

  return Object.assign(handler, { close })
}
