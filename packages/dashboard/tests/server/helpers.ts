import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import pg from 'pg'
import crypto from 'node:crypto'
import { PgBoss } from 'pg-boss'

const { Pool } = pg

// Connection config - supports both local dev and CI
const getConnectionConfig = () => {
  // CI provides DATABASE_URL
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL)
    return {
      host: url.hostname,
      port: parseInt(url.port || '5432', 10),
      database: url.pathname.slice(1) || 'postgres',
      user: url.username,
      password: url.password,
      max: 3,
    }
  }

  // Local dev uses pg-boss's docker-compose defaults
  return {
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: 'pgboss',
    user: 'postgres',
    password: 'postgres',
    max: 3,
  }
}

const connectionConfig = getConnectionConfig()

export const connectionString = process.env.DATABASE_URL ||
  `postgres://${connectionConfig.user}:${connectionConfig.password}@${connectionConfig.host}:${connectionConfig.port}/${connectionConfig.database}`

const sha1 = (value: string): string =>
  crypto.createHash('sha1').update(value).digest('hex')

let pool: pg.Pool | null = null
let currentSchema: string = ''
let currentBoss: PgBoss | null = null

function getPool (): pg.Pool {
  if (!pool) {
    pool = new Pool(connectionConfig)
  }
  return pool
}

export function getTestSchema (): string {
  return currentSchema
}

export function getTestConnectionString (): string {
  return connectionString
}

export function getBoss (): PgBoss {
  if (!currentBoss) {
    throw new Error('pg-boss instance not initialized. Call this from within a test.')
  }
  return currentBoss
}

async function createDatabase (): Promise<void> {
  // Only needed for local dev where we use a specific database
  if (process.env.DATABASE_URL) {
    return
  }

  const adminPool = new Pool({
    ...connectionConfig,
    database: 'postgres',
  })

  try {
    await adminPool.query(`CREATE DATABASE ${connectionConfig.database}`)
  } catch {
    // Database may already exist
  } finally {
    await adminPool.end()
  }
}

async function dropSchema (schema: string): Promise<void> {
  const p = getPool()
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
}

// Helper to create warning table for tests that need it
// pg-boss only creates this table when persistWarnings is enabled
export async function createWarningTable (schema: string): Promise<void> {
  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.warning (
      id serial PRIMARY KEY,
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamptz DEFAULT now()
    )
  `)
  await p.query(`
    CREATE INDEX IF NOT EXISTS warning_i1 ON ${schema}.warning (created_on DESC)
  `)
}

export interface TestContext {
  schema: string;
  connectionString: string;
}

export const ctx: TestContext = {
  schema: '',
  connectionString: '',
}

beforeAll(async () => {
  await createDatabase()
})

beforeEach(async (context) => {
  const testFile = context.task.file?.name || 'unknown'
  const testName = context.task.name || 'unknown'
  const testKey = testFile + testName
  const schema = `pgboss_test_${sha1(testKey).slice(0, 12)}`

  currentSchema = schema
  ctx.schema = schema
  ctx.connectionString = connectionString

  // Clean up any existing schema
  await dropSchema(schema)

  // Use pg-boss to create the schema - this ensures we test against the real schema
  currentBoss = new PgBoss({
    connectionString,
    schema,
    // Disable background processes for testing
    supervise: false,
    schedule: false,
    migrate: true,
    persistWarnings: true,
  })

  // Suppress error events during tests
  currentBoss.on('error', () => {})

  await currentBoss.start()
})

afterEach(async (context) => {
  // Stop pg-boss first
  if (currentBoss) {
    await currentBoss.stop({ close: true })
    currentBoss = null
  }

  const state = context.task.result?.state
  if (state === 'pass' && currentSchema) {
    await dropSchema(currentSchema)
  }
})

afterAll(async () => {
  if (pool) {
    await pool.end()
    pool = null
  }
})

// Helper to create a test queue using pg-boss
export async function createTestQueue (
  name: string,
  options: Parameters<PgBoss['createQueue']>[1] = {}
): Promise<void> {
  const boss = getBoss()
  await boss.createQueue(name, options)
}

// Helper to send a test job using pg-boss
export async function sendTestJob (
  queueName: string,
  data: object = {},
  options: Parameters<PgBoss['send']>[2] = {}
): Promise<string | null> {
  const boss = getBoss()
  return boss.send(queueName, data, options)
}

// Helper to insert a test warning
// Note: pg-boss emits warnings via events but doesn't have a public API to insert them
// The warning table is populated by pg-boss internally when persistWarnings is enabled
export async function insertTestWarning (
  schema: string,
  type: string,
  message: string,
  data: object = {}
): Promise<number> {
  const p = getPool()
  const result = await p.query(
    `
    INSERT INTO ${schema}.warning (type, message, data)
    VALUES ($1, $2, $3)
    RETURNING id
  `,
    [type, message, JSON.stringify(data)]
  )
  return result.rows[0].id
}

// Helper to update queue stats
// Note: Queue stats are normally updated by pg-boss's monitor process
// We update them manually for deterministic testing without waiting for monitor cycles
export async function updateQueueStats (
  schema: string,
  queueName: string,
  stats: { queuedCount?: number; activeCount?: number; totalCount?: number; deferredCount?: number }
): Promise<void> {
  const p = getPool()
  const sets: string[] = []
  const values: (string | number)[] = [queueName]
  let paramIndex = 2

  if (stats.queuedCount !== undefined) {
    sets.push(`queued_count = $${paramIndex++}`)
    values.push(stats.queuedCount)
  }
  if (stats.activeCount !== undefined) {
    sets.push(`active_count = $${paramIndex++}`)
    values.push(stats.activeCount)
  }
  if (stats.totalCount !== undefined) {
    sets.push(`total_count = $${paramIndex++}`)
    values.push(stats.totalCount)
  }
  if (stats.deferredCount !== undefined) {
    sets.push(`deferred_count = $${paramIndex++}`)
    values.push(stats.deferredCount)
  }

  if (sets.length > 0) {
    await p.query(
      `UPDATE ${schema}.queue SET ${sets.join(', ')} WHERE name = $1`,
      values
    )
  }
}

// Helpers to change job state using pg-boss APIs
export async function fetchTestJob (queueName: string): Promise<{ id: string; data: unknown } | null> {
  const boss = getBoss()
  const jobs = await boss.fetch(queueName)
  return jobs.length > 0 ? { id: jobs[0].id, data: jobs[0].data } : null
}

export async function completeTestJob (queueName: string, jobId: string, output?: object): Promise<void> {
  const boss = getBoss()
  await boss.complete(queueName, jobId, output)
}

export async function failTestJob (queueName: string, jobId: string, error?: Error): Promise<void> {
  const boss = getBoss()
  await boss.fail(queueName, jobId, error)
}

export async function cancelTestJob (queueName: string, jobId: string): Promise<void> {
  const boss = getBoss()
  await boss.cancel(queueName, jobId)
}
