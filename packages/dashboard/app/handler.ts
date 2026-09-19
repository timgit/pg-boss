import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from './server'
import { toDatabaseConfig, type DatabaseInput } from './lib/config.server'
import { withBasePath } from './lib/runtime-base-path'

export type { DatabaseInput }

export interface CreateDashboardHandlerOptions {
  /** The first one is selected by default. */
  databases: DatabaseInput[];
  /** Where the host mounts the handler, e.g. `/admin/queues`. Requests keep this prefix. */
  basePath?: string;
  /** Hosts (`host[:port]`, `*.example.com`) a form may be submitted from when a proxy hides the public origin. */
  allowedActionOrigins?: string[];
}

export interface DashboardHandler {
  (request: Request): Promise<Response>;
  /** Closes the database pools. Final: the handler cannot serve requests afterwards. */
  close (): Promise<void>;
}

const EMBEDDED_KEY = Symbol.for('pgboss.dashboard.embedded')
const CLOSE_POOLS_KEY = Symbol.for('pgboss.dashboard.closeAllPools')
const STOP_INSTANCES_KEY = Symbol.for('pgboss.dashboard.stopAllInstances')

/**
 * A Fetch API handler for the dashboard, to mount inside an existing application.
 * It adds no authentication, and loads nothing until the first request.
 */
export function createDashboardHandler ({ databases, basePath, allowedActionOrigins }: CreateDashboardHandlerOptions): DashboardHandler {
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
    const build = (await import(buildModulePath)) as unknown as ServerBuild

    return createHonoApp({
      build,
      mode: 'production',
      serveStaticAssets: true,
      clientRoot: fileURLToPath(new URL('./client', import.meta.url)),
      databases: configs,
      basePath,
      auth: false,
      allowedActionOrigins,
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
