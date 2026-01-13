import pg from 'pg'

const { Pool } = pg

// Store pools by connection string to support multiple databases
const pools = new Map<string, pg.Pool>()

// Track if shutdown is in progress to prevent new queries
let isShuttingDown = false

export function getPool (connectionString: string): pg.Pool {
  if (isShuttingDown) {
    throw new Error('Database pool is shutting down')
  }
  let pool = pools.get(connectionString)
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 10,
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
