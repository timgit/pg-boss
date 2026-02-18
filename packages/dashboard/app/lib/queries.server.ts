import { query, queryOne } from './db.server'
import type {
  QueueResult,
  JobResult,
  WarningResult,
  QueueStats,
  ScheduleResult,
} from './types'

// Validate schema name to prevent SQL injection
// Schema names must be valid PostgreSQL identifiers
function validateIdentifier (name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`)
  }
  return name
}

// Shared column definitions to avoid duplication
const QUEUE_COLUMNS = `
  name,
  policy,
  partition,
  dead_letter as "deadLetter",
  retry_limit as "retryLimit",
  retry_delay as "retryDelay",
  retry_backoff as "retryBackoff",
  retry_delay_max as "retryDelayMax",
  expire_seconds as "expireInSeconds",
  retention_seconds as "retentionSeconds",
  deletion_seconds as "deleteAfterSeconds",
  deferred_count as "deferredCount",
  queued_count as "queuedCount",
  active_count as "activeCount",
  total_count as "totalCount",
  warning_queued as "warningQueueSize",
  singletons_active as "singletonsActive",
  table_name as "table",
  monitor_on as "monitorOn",
  maintain_on as "maintainOn",
  created_on as "createdOn",
  updated_on as "updatedOn"
`

// Lightweight columns for job list (excludes data and output to save memory)
const JOB_LIST_COLUMNS = `
  id,
  name,
  state,
  priority,
  retry_count as "retryCount",
  retry_limit as "retryLimit",
  start_after as "startAfter",
  started_on as "startedOn",
  completed_on as "completedOn",
  created_on as "createdOn",
  singleton_key as "singletonKey"
`

// Get queues with cached stats, with optional pagination, filtering, and search
export async function getQueues (
  dbUrl: string,
  schema: string,
  options: {
    limit?: number;
    offset?: number;
    filter?: 'all' | 'attention' | 'partitioned';
    search?: string;
  } = {}
): Promise<QueueResult[]> {
  const s = validateIdentifier(schema)
  const { limit, offset, filter = 'all', search } = options

  // Build WHERE conditions
  const conditions: string[] = []
  const params: unknown[] = []
  let paramIndex = 1

  // Add filter conditions
  if (filter === 'attention') {
    conditions.push('warning_queued > 0 AND queued_count > warning_queued')
  } else if (filter === 'partitioned') {
    conditions.push('partition = true')
  }

  // Add search condition
  if (search && search.trim()) {
    conditions.push(`name ILIKE $${paramIndex}`)
    params.push(`%${search.trim()}%`)
    paramIndex++
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // If no pagination, return all queues
  if (limit === undefined) {
    const sql = `
      SELECT ${QUEUE_COLUMNS}
      FROM ${s}.queue
      ${whereClause}
      ORDER BY name
    `
    return query<QueueResult>(dbUrl, sql, params)
  }

  // With pagination
  params.push(limit, offset ?? 0)
  const sql = `
    SELECT ${QUEUE_COLUMNS}
    FROM ${s}.queue
    ${whereClause}
    ORDER BY name
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `
  return query<QueueResult>(dbUrl, sql, params)
}

// Get total count of queues with optional filtering and search
export async function getQueueCount (
  dbUrl: string,
  schema: string,
  options: {
    filter?: 'all' | 'attention' | 'partitioned';
    search?: string;
  } = {}
): Promise<number> {
  const s = validateIdentifier(schema)
  const { filter = 'all', search } = options

  // Build WHERE conditions
  const conditions: string[] = []
  const params: unknown[] = []
  let paramIndex = 1

  // Add filter conditions
  if (filter === 'attention') {
    conditions.push('warning_queued > 0 AND queued_count > warning_queued')
  } else if (filter === 'partitioned') {
    conditions.push('partition = true')
  }

  // Add search condition
  if (search && search.trim()) {
    conditions.push(`name ILIKE $${paramIndex}`)
    params.push(`%${search.trim()}%`)
    paramIndex++
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const sql = `SELECT COUNT(*)::int as count FROM ${s}.queue ${whereClause}`
  const result = await queryOne<{ count: number }>(dbUrl, sql, params)
  return result?.count ?? 0
}

// Get count of queues needing attention (backlog exceeding warning threshold)
export async function getProblemQueuesCount (
  dbUrl: string,
  schema: string
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT COUNT(*)::int as count
    FROM ${s}.queue
    WHERE warning_queued > 0 AND queued_count > warning_queued
  `
  const result = await queryOne<{ count: number }>(dbUrl, sql)
  return result?.count ?? 0
}

// Get queues that have a backlog exceeding their warning threshold
// This is more efficient than fetching all queues and filtering client-side
export async function getProblemQueues (
  dbUrl: string,
  schema: string,
  limit: number = 10
): Promise<QueueResult[]> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT ${QUEUE_COLUMNS}
    FROM ${s}.queue
    WHERE warning_queued > 0 AND queued_count > warning_queued
    ORDER BY (queued_count - warning_queued) DESC
    LIMIT $1
  `
  return query<QueueResult>(dbUrl, sql, [limit])
}

// Get top queues by total job count
export async function getTopQueues (
  dbUrl: string,
  schema: string,
  limit: number = 5
): Promise<QueueResult[]> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT ${QUEUE_COLUMNS}
    FROM ${s}.queue
    ORDER BY total_count DESC
    LIMIT $1
  `
  return query<QueueResult>(dbUrl, sql, [limit])
}

// Get a single queue by name
export async function getQueue (
  dbUrl: string,
  schema: string,
  name: string
): Promise<QueueResult | null> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT ${QUEUE_COLUMNS}
    FROM ${s}.queue
    WHERE name = $1
  `
  return queryOne<QueueResult>(dbUrl, sql, [name])
}

// Get recent jobs across all queues with pagination
// Uses lightweight columns and includes queue name
export async function getRecentJobs (
  dbUrl: string,
  schema: string,
  options: {
    state?: string | null;
    limit?: number;
    offset?: number;
  } = {}
): Promise<JobResult[]> {
  const s = validateIdentifier(schema)
  const { state = null, limit = 20, offset = 0 } = options

  // Handle 'pending' filter for non-final states
  if (state === 'pending') {
    const sql = `
      SELECT ${JOB_LIST_COLUMNS}
      FROM ${s}.job
      WHERE state < 'completed'
      ORDER BY created_on DESC
      LIMIT $1 OFFSET $2
    `
    return query<JobResult>(dbUrl, sql, [limit, offset])
  }

  // Handle 'all' filter or null - no state filtering
  if (state === 'all' || state === null) {
    const sql = `
      SELECT ${JOB_LIST_COLUMNS}
      FROM ${s}.job
      ORDER BY created_on DESC
      LIMIT $1 OFFSET $2
    `
    return query<JobResult>(dbUrl, sql, [limit, offset])
  }

  // Filter by specific state
  const sql = `
    SELECT ${JOB_LIST_COLUMNS}
    FROM ${s}.job
    WHERE state = $1::${s}.job_state
    ORDER BY created_on DESC
    LIMIT $2 OFFSET $3
  `
  return query<JobResult>(dbUrl, sql, [state, limit, offset])
}

// Get jobs for a queue with pagination and filtering
// Uses lightweight columns to avoid loading large payloads
// For counts, we use cached stats from the queue table instead of COUNT(*).
// Supports 'pending' filter for non-final states (created, retry, active)
// Supports 'all' filter for all states (no filtering)
export async function getJobs (
  dbUrl: string,
  schema: string,
  queueName: string,
  options: {
    state?: string | null;
    limit?: number;
    offset?: number;
  } = {}
): Promise<JobResult[]> {
  const s = validateIdentifier(schema)
  const { state = null, limit = 50, offset = 0 } = options

  // Handle 'pending' filter for non-final states
  if (state === 'pending') {
    const sql = `
      SELECT ${JOB_LIST_COLUMNS}
      FROM ${s}.job
      WHERE name = $1
      AND state < 'completed'
      ORDER BY created_on DESC
      LIMIT $2 OFFSET $3
    `
    return query<JobResult>(dbUrl, sql, [queueName, limit, offset])
  }

  // Handle 'all' filter or null - no state filtering
  if (state === 'all' || state === null) {
    const sql = `
      SELECT ${JOB_LIST_COLUMNS}
      FROM ${s}.job
      WHERE name = $1
      ORDER BY created_on DESC
      LIMIT $2 OFFSET $3
    `
    return query<JobResult>(dbUrl, sql, [queueName, limit, offset])
  }

  // Filter by specific state
  const sql = `
    SELECT ${JOB_LIST_COLUMNS}
    FROM ${s}.job
    WHERE name = $1
    AND state = $2::${s}.job_state
    ORDER BY created_on DESC
    LIMIT $3 OFFSET $4
  `
  return query<JobResult>(dbUrl, sql, [queueName, state, limit, offset])
}

// Get job counts from cached queue stats
// Maps state filters to the appropriate cached count from the queue table
// This avoids expensive COUNT(*) queries against the job table
export function getJobCountFromQueue (
  queue: QueueResult,
  stateFilter: string | null
): number | null {
  // Map state filters to cached counts where available
  // Note: created and retry are combined in queuedCount
  switch (stateFilter) {
    case null:
    case 'all':
      return queue.totalCount
    case 'pending':
      // Pending = all non-final states (created + retry + active)
      // queuedCount includes created + retry, activeCount includes active
      return queue.queuedCount + queue.activeCount
    case 'created':
    case 'retry':
      // queuedCount includes both created and retry states
      // We can't distinguish between them without querying, so return null
      return null
    case 'active':
      return queue.activeCount
    default:
      // For completed, cancelled, failed - no cached count available
      return null
  }
}

// Get warnings with pagination and filtering
// Returns empty array if warning table doesn't exist (persistWarnings not enabled)
export async function getWarnings (
  dbUrl: string,
  schema: string,
  options: {
    type?: string | null;
    limit?: number;
    offset?: number;
  } = {}
): Promise<WarningResult[]> {
  const s = validateIdentifier(schema)
  const { type = null, limit = 50, offset = 0 } = options

  const sql = `
    SELECT
      id,
      type,
      message,
      data,
      created_on as "createdOn"
    FROM ${s}.warning
    WHERE ($1::text IS NULL OR type = $1)
    ORDER BY created_on DESC
    LIMIT $2 OFFSET $3
  `
  try {
    return await query<WarningResult>(dbUrl, sql, [type, limit, offset])
  } catch (err: unknown) {
    // Table doesn't exist - persistWarnings not enabled
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return []
    }
    throw err
  }
}

// Delete warnings older than specified days
// Returns the number of deleted warnings, or 0 if warning table doesn't exist
export async function deleteOldWarnings (
  dbUrl: string,
  schema: string,
  olderThanDays: number = 30
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    WITH deleted AS (
      DELETE FROM ${s}.warning
      WHERE created_on < now() - interval '1 day' * $1
      RETURNING 1
    )
    SELECT COUNT(*)::int as count FROM deleted
  `
  try {
    const result = await queryOne<{ count: number }>(dbUrl, sql, [olderThanDays])
    return result?.count ?? 0
  } catch (err: unknown) {
    // Table doesn't exist - persistWarnings not enabled
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return 0
    }
    throw err
  }
}

// Get warning count (for pagination)
// Returns 0 if warning table doesn't exist (persistWarnings not enabled)
export async function getWarningCount (
  dbUrl: string,
  schema: string,
  type?: string | null
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT COUNT(*)::int as count
    FROM ${s}.warning
    WHERE ($1::text IS NULL OR type = $1)
  `
  try {
    const result = await queryOne<{ count: number }>(dbUrl, sql, [type ?? null])
    return result?.count ?? 0
  } catch (err: unknown) {
    // Table doesn't exist - persistWarnings not enabled
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return 0
    }
    throw err
  }
}

export async function getQueueStats (
  dbUrl: string,
  schema: string
): Promise<QueueStats> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT
      COALESCE(SUM(deferred_count), 0)::int as "totalDeferred",
      COALESCE(SUM(queued_count), 0)::int as "totalQueued",
      COALESCE(SUM(active_count), 0)::int as "totalActive",
      COALESCE(SUM(total_count), 0)::int as "totalJobs",
      COUNT(*)::int as "queueCount"
    FROM ${s}.queue
  `
  const result = await queryOne<QueueStats>(dbUrl, sql)
  return (
    result ?? {
      totalDeferred: 0,
      totalQueued: 0,
      totalActive: 0,
      totalJobs: 0,
      queueCount: 0,
    }
  )
}

const JOB_INTENTS = ['cancel', 'retry', 'resume', 'delete'] as const
type JobActionIntent = (typeof JOB_INTENTS)[number]

export function isValidIntent (intent: unknown): intent is JobActionIntent {
  return typeof intent === 'string' && JOB_INTENTS.includes(intent as JobActionIntent)
}

export async function retryJob (
  dbUrl: string,
  schema: string,
  queueName: string,
  jobId: string
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    WITH results as (
      UPDATE ${s}.job
      SET state = 'retry',
        retry_limit = retry_count + 1,
        completed_on = NULL,
        started_on = NULL
      WHERE name = $1
        AND id = $2
        AND state = 'failed'
      RETURNING 1
    )
    SELECT COUNT(*)::int as count FROM results
  `
  const result = await queryOne<{ count: number }>(dbUrl, sql, [
    queueName,
    jobId,
  ])
  return result?.count ?? 0
}

// Get all schedules with pagination
export async function getSchedules (
  dbUrl: string,
  schema: string,
  options: {
    limit?: number;
    offset?: number;
  } = {}
): Promise<ScheduleResult[]> {
  const s = validateIdentifier(schema)
  const { limit, offset } = options

  const sql = `
    SELECT
      name,
      key,
      cron,
      timezone,
      data,
      options,
      created_on as "createdOn",
      updated_on as "updatedOn"
    FROM ${s}.schedule
    ORDER BY name, key
    ${limit !== undefined ? 'LIMIT $1 OFFSET $2' : ''}
  `

  const params: unknown[] = (limit !== undefined) ? [limit, offset ?? 0] : []

  return await query<ScheduleResult>(dbUrl, sql, params)
}

export async function getScheduleCount (dbUrl: string, schema: string): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `SELECT COUNT(*)::int as count FROM ${s}.schedule`

  const result = await queryOne<{ count: number }>(dbUrl, sql)
  return result?.count ?? 0
}

export async function getSchedule (
  dbUrl: string,
  schema: string,
  name: string,
  key: string
): Promise<ScheduleResult | null> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT
      name,
      key,
      cron,
      timezone,
      data,
      options,
      created_on as "createdOn",
      updated_on as "updatedOn"
    FROM ${s}.schedule
    WHERE name = $1 AND key = $2
  `

  return await queryOne<ScheduleResult>(dbUrl, sql, [name, key])
}

// Find a job by ID across all queues (scans all partitions)
export async function findJobById (
  dbUrl: string,
  schema: string,
  id: string
): Promise<{ id: string; name: string } | null> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT id, name
    FROM ${s}.job
    WHERE id = $1
    LIMIT 1
  `
  return queryOne<{ id: string; name: string }>(dbUrl, sql, [id])
}

// Re-export job action methods from boss.server
export { getJobById, cancelJob, resumeJob, deleteJob } from './boss.server'
