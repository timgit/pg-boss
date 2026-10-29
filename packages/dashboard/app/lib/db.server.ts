import pg from 'pg'

const { Pool } = pg

// Store pools by connection string to support multiple databases
const pools = new Map<string, pg.Pool>()

// Track if shutdown is in progress to prevent new queries
let isShuttingDown = false

const DEFAULT_QUERY_TIMEOUT_MS = 60_000
// Client-side backstop fires only if the server-side kill never arrives
// (e.g. network partition), so it sits above statement_timeout.
const CLIENT_TIMEOUT_HEADROOM_MS = 5_000

export function getQueryTimeoutMs (): number {
  const raw = Number.parseInt(process.env.PGBOSS_DASHBOARD_QUERY_TIMEOUT ?? '', 10)
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_QUERY_TIMEOUT_MS
}

// Matches both the server-side cancellation (Postgres 57014 query_canceled,
// raised by statement_timeout) and pg's client-side query_timeout, which
// rejects with a plain Error carrying no code.
export function isQueryTimeoutError (err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  if ('code' in err && (err as { code?: unknown }).code === '57014') return true
  return err instanceof Error && err.message === 'Query read timeout'
}

export function getPool (connectionString: string): pg.Pool {
  if (isShuttingDown) {
    throw new Error('Database pool is shutting down')
  }
  let pool = pools.get(connectionString)
  if (!pool) {
    // Read the timeout at pool-creation time (not module level) so tests can
    // stub the env var and pick it up with a fresh pool.
    const timeoutMs = getQueryTimeoutMs()
    pool = new Pool({
      connectionString,
      max: 10,
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs + CLIENT_TIMEOUT_HEADROOM_MS,
    })

    // Handle pool errors to prevent unhandled rejections
    pool.on('error', (err) => {
      console.error('Unexpected database pool error:', err)
    })

    pools.set(connectionString, pool)
  }
  return pool
}

export async function query<T = unknown> (
  connectionString: string,
  text: string,
  values?: unknown[]
): Promise<T[]> {
  const pool = getPool(connectionString)
  const result = await pool.query(text, values)
  return result.rows as T[]
}

export async function queryOne<T = unknown> (
  connectionString: string,
  text: string,
  values?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(connectionString, text, values)
  return rows[0] ?? null
}

// Cleanup function for graceful shutdown
export async function closeAllPools (): Promise<void> {
  isShuttingDown = true
  const closing = [...pools.values()]
  pools.clear()
  await Promise.all(closing.map(pool => pool.end()))

  // Embedded, another handler may still be open or be created later. Standalone, the process exits.
  if (globalStore[EMBEDDED_KEY]) {
    isShuttingDown = false
  }
}

// Standalone, the dashboard owns the process: run the `onClose` steps, close the pools and exit on
// a signal. Embedded, the host does, so `createDashboardHandler()` sets this flag and runs the same
// close itself, through globalThis because it lives in another bundle (as db-context.ts does for
// its token).
const EMBEDDED_KEY = Symbol.for('pgboss.dashboard.embedded')
const CLOSE_POOLS_KEY = Symbol.for('pgboss.dashboard.closeAllPools')
const globalStore = globalThis as typeof globalThis & {
  [EMBEDDED_KEY]?: boolean
  [CLOSE_POOLS_KEY]?: () => Promise<void>
}

const closers = new Set<() => Promise<void>>()

/**
 * Run `close` before the pools end, when a signal stops the standalone server or a host calls
 * the handler's `close()`. For work that has to finish first, such as a job the Pro overlay's
 * evaluator is running. A rejection is logged and does not hold up the rest.
 */
export function onClose (close: () => Promise<void>): void {
  closers.add(close)
}

async function closeAll (): Promise<void> {
  const results = await Promise.allSettled([...closers].map((close) => close()))

  for (const result of results) {
    if (result.status === 'rejected') console.error('Shutdown step failed:', result.reason)
  }

  await closeAllPools()
}

globalStore[CLOSE_POOLS_KEY] = closeAll

if (typeof process !== 'undefined' && !globalStore[EMBEDDED_KEY]) {
  let cleanupInProgress: Promise<void> | null = null

  const cleanup = async () => {
    if (cleanupInProgress) {
      await cleanupInProgress
      return
    }
    cleanupInProgress = closeAll()
    await cleanupInProgress
  }

  // Use async handler that waits for cleanup to complete
  process.on('SIGINT', () => {
    cleanup().finally(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    cleanup().finally(() => process.exit(0))
  })
}
