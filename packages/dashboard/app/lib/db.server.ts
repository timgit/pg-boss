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
  const closePromises: Promise<void>[] = []
  for (const [connectionString, pool] of pools) {
    closePromises.push(
      pool.end().then(() => {
        pools.delete(connectionString)
      })
    )
  }
  await Promise.all(closePromises)
}

// Register cleanup on process exit
if (typeof process !== 'undefined') {
  let cleanupInProgress: Promise<void> | null = null

  const cleanup = async () => {
    if (cleanupInProgress) {
      await cleanupInProgress
      return
    }
    cleanupInProgress = closeAllPools()
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
