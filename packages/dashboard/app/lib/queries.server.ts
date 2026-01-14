import { query, queryOne } from './db.server'
import type {
  QueueResult,
  JobResult,
  WarningResult,
  AggregateStats,
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
  expire_seconds as "expireSeconds",
  retention_seconds as "retentionSeconds",
  deletion_seconds as "deletionSeconds",
  deferred_count as "deferredCount",
  queued_count as "queuedCount",
  active_count as "activeCount",
  total_count as "totalCount",
  warning_queued as "warningQueued",
  singletons_active as "singletonsActive",
  monitor_on as "monitorOn",
  maintain_on as "maintainOn",
  created_on as "createdOn",
  updated_on as "updatedOn"
`

// Full job columns for single job detail view
const JOB_COLUMNS = `
  id,
  name,
  data,
  state,
  priority,
  retry_count as "retryCount",
  retry_limit as "retryLimit",
  retry_delay as "retryDelay",
  retry_backoff as "retryBackoff",
  start_after as "startAfter",
  started_on as "startedOn",
  completed_on as "completedOn",
  created_on as "createdOn",
  keep_until as "keepUntil",
  output,
  singleton_key as "singletonKey",
  group_id as "groupId",
  group_tier as "groupTier",
  dead_letter as "deadLetter",
  policy
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

// Get queues with cached stats, with optional pagination
export async function getQueues (
  dbUrl: string,
  schema: string,
  options: {
    limit?: number;
    offset?: number;
  } = {}
): Promise<QueueResult[]> {
  const s = validateIdentifier(schema)
  const { limit, offset } = options

  // If no pagination, return all queues
  if (limit === undefined) {
    const sql = `
      SELECT ${QUEUE_COLUMNS}
      FROM ${s}.queue
      ORDER BY name
    `
    return query<QueueResult>(dbUrl, sql)
  }

  // With pagination
  const sql = `
    SELECT ${QUEUE_COLUMNS}
    FROM ${s}.queue
    ORDER BY name
    LIMIT $1 OFFSET $2
  `
  return query<QueueResult>(dbUrl, sql, [limit, offset ?? 0])
}

// Get total count of queues
export async function getQueueCount (
  dbUrl: string,
  schema: string
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `SELECT COUNT(*)::int as count FROM ${s}.queue`
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

// Get a single queue by name
export async function getQueue (
  dbUrl: string,
  schema: string,
  name: string
): Promise<QueueResult | null> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT ${QUEUE_COLUMNS},
      table_name as "tableName"
    FROM ${s}.queue
    WHERE name = $1
  `
  return queryOne<QueueResult>(dbUrl, sql, [name])
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

// Get a single job by ID
export async function getJob (
  dbUrl: string,
  schema: string,
  queueName: string,
  jobId: string
): Promise<JobResult | null> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT ${JOB_COLUMNS}
    FROM ${s}.job
    WHERE name = $1 AND id = $2
  `
  return queryOne<JobResult>(dbUrl, sql, [queueName, jobId])
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

// Get aggregate stats across all queues (uses cached stats, no COUNT(*))
export async function getAggregateStats (
  dbUrl: string,
  schema: string
): Promise<AggregateStats> {
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
  const result = await queryOne<AggregateStats>(dbUrl, sql)
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

// Valid intents for job actions
const VALID_INTENTS = ['cancel', 'retry', 'resume', 'delete', 'view'] as const
type JobActionIntent = (typeof VALID_INTENTS)[number]

export function isValidIntent (intent: unknown): intent is JobActionIntent {
  return typeof intent === 'string' && VALID_INTENTS.includes(intent as JobActionIntent)
}

// Cancel a job
export async function cancelJob (
  dbUrl: string,
  schema: string,
  queueName: string,
  jobId: string
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    WITH results as (
      UPDATE ${s}.job
      SET completed_on = now(),
        state = 'cancelled'
      WHERE name = $1
        AND id = $2
        AND state < 'completed'
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

// Retry a failed job manually via dashboard
// Sets state to 'retry' and clears completed_on/started_on timestamps
//
// IMPORTANT: This is a manual override that allows one more attempt regardless of retry_limit.
// The retry_count is NOT reset or incremented - we're simply giving the job another chance.
// If the job was already at retry_limit, it may fail immediately again when picked up
// if it encounters the same error. This is intentional - the user is explicitly requesting
// a retry, presumably after fixing the underlying issue or for debugging purposes.
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

// Resume a cancelled job
// Sets state back to 'created' so it will be picked up again
export async function resumeJob (
  dbUrl: string,
  schema: string,
  queueName: string,
  jobId: string
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    WITH results as (
      UPDATE ${s}.job
      SET state = 'created',
        completed_on = NULL,
        started_on = NULL
      WHERE name = $1
        AND id = $2
        AND state = 'cancelled'
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

// Delete a job
// Only allows deleting jobs that are not currently active
// Active jobs should be cancelled first to ensure workers aren't affected
export async function deleteJob (
  dbUrl: string,
  schema: string,
  queueName: string,
  jobId: string
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    WITH results as (
      DELETE FROM ${s}.job
      WHERE name = $1 AND id = $2
        AND state <> 'active'
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
