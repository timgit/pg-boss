import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import pg from 'pg'
import crypto from 'node:crypto'

const { Pool } = pg

// Connection config matching pg-boss's docker-compose.yaml
const connectionConfig = {
  host: process.env.POSTGRES_HOST || '127.0.0.1',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: 'pgboss',
  user: 'postgres',
  password: 'postgres',
  max: 3,
}

export const connectionString = `postgres://${connectionConfig.user}:${connectionConfig.password}@${connectionConfig.host}:${connectionConfig.port}/${connectionConfig.database}`

const sha1 = (value: string): string =>
  crypto.createHash('sha1').update(value).digest('hex')

let pool: pg.Pool | null = null
let currentSchema: string = ''

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

async function createDatabase (): Promise<void> {
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

async function createSchema (schema: string): Promise<void> {
  const p = getPool()
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)

  // Create the required tables for dashboard testing
  await p.query(`
    CREATE TYPE ${schema}.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  `)

  await p.query(`
    CREATE TABLE ${schema}.queue (
      name text NOT NULL PRIMARY KEY,
      policy text NOT NULL DEFAULT 'standard',
      partition boolean NOT NULL DEFAULT false,
      dead_letter text,
      retry_limit int NOT NULL DEFAULT 2,
      retry_delay int NOT NULL DEFAULT 0,
      retry_backoff boolean NOT NULL DEFAULT false,
      retry_delay_max int,
      expire_seconds int NOT NULL DEFAULT 900,
      retention_seconds int NOT NULL DEFAULT 1209600,
      deletion_seconds int NOT NULL DEFAULT 604800,
      deferred_count int NOT NULL DEFAULT 0,
      queued_count int NOT NULL DEFAULT 0,
      active_count int NOT NULL DEFAULT 0,
      total_count int NOT NULL DEFAULT 0,
      warning_queued int NOT NULL DEFAULT 0,
      singletons_active text[],
      table_name text,
      monitor_on timestamptz,
      maintain_on timestamptz,
      created_on timestamptz NOT NULL DEFAULT now(),
      updated_on timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE TABLE ${schema}.job (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      name text NOT NULL,
      data jsonb,
      state ${schema}.job_state NOT NULL DEFAULT 'created',
      priority int NOT NULL DEFAULT 0,
      retry_count int NOT NULL DEFAULT 0,
      retry_limit int NOT NULL DEFAULT 2,
      retry_delay int NOT NULL DEFAULT 0,
      retry_backoff boolean NOT NULL DEFAULT false,
      start_after timestamptz NOT NULL DEFAULT now(),
      started_on timestamptz,
      completed_on timestamptz,
      created_on timestamptz NOT NULL DEFAULT now(),
      keep_until timestamptz NOT NULL DEFAULT now() + interval '14 days',
      output jsonb,
      singleton_key text,
      group_id text,
      group_tier text,
      dead_letter text,
      policy text,
      PRIMARY KEY (name, id)
    )
  `)

  await p.query(`
    CREATE TABLE ${schema}.warning (
      id serial PRIMARY KEY,
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE INDEX warning_i1 ON ${schema}.warning (created_on DESC)
  `)

  // Create indexes for efficient job queries
  // Index for filtering by queue and state with created_on ordering (used by dashboard pagination)
  await p.query(`
    CREATE INDEX job_queue_state_created ON ${schema}.job (name, state, created_on DESC)
  `)

  // Index for queue name ordering (used by queues list)
  await p.query(`
    CREATE INDEX queue_name ON ${schema}.queue (name)
  `)
}

async function dropSchema (schema: string): Promise<void> {
  const p = getPool()
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
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

  await dropSchema(schema)
  await createSchema(schema)
})

afterEach(async (context) => {
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

// Helper to insert test data
export async function insertTestQueue (
  schema: string,
  name: string,
  overrides: Partial<{
    policy: string;
    queuedCount: number;
    activeCount: number;
    totalCount: number;
  }> = {}
): Promise<void> {
  const p = getPool()
  await p.query(
    `
    INSERT INTO ${schema}.queue (name, policy, queued_count, active_count, total_count)
    VALUES ($1, $2, $3, $4, $5)
  `,
    [
      name,
      overrides.policy || 'standard',
      overrides.queuedCount || 0,
      overrides.activeCount || 0,
      overrides.totalCount || 0,
    ]
  )
}

export async function insertTestJob (
  schema: string,
  queueName: string,
  overrides: Partial<{
    state: string;
    priority: number;
    data: object;
  }> = {}
): Promise<string> {
  const p = getPool()
  const result = await p.query(
    `
    INSERT INTO ${schema}.job (name, state, priority, data)
    VALUES ($1, $2::${schema}.job_state, $3, $4)
    RETURNING id
  `,
    [
      queueName,
      overrides.state || 'created',
      overrides.priority || 0,
      JSON.stringify(overrides.data || {}),
    ]
  )
  return result.rows[0].id
}

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
