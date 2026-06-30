import { query, queryOne } from './db.server'
import type { JobStateFilter } from './utils'
import {
  isBuiltinJobColumnPath,
  jobColumnDbColumn,
  type JobColumn,
} from './job-columns'
import type {
  QueueResult,
  JobResult,
  WarningResult,
  QueueStats,
  QueueStatsPoint,
  QueueStatsAggregate,
  ScheduleResult,
  BamEntryResult,
  BamStatusSummary,
} from './types'

export interface SortOptions {
  sort?: string | null;
  dir?: string | null;
}

// Map a UI sort key + direction into a safe ORDER BY clause. The key is resolved to a real column
// through an allowlist (so it can never inject), the direction is constrained to ASC/DESC, and a
// stable tiebreaker keeps pagination deterministic across ties. Unknown keys fall back to the list's
// default ordering.
function buildOrderBy (
  { sort, dir }: SortOptions,
  columns: Record<string, string>,
  defaultOrderBy: string,
  tiebreak?: string
): string {
  const column = sort ? columns[sort] : undefined
  if (!column) return `ORDER BY ${defaultOrderBy}`
  const direction = dir === 'desc' ? 'DESC' : 'ASC'
  return `ORDER BY ${column} ${direction}${tiebreak ? `, ${tiebreak}` : ''}`
}

// Per-list allowlists mapping sort keys (used in the URL + column headers) to real columns.
const QUEUE_SORT_COLUMNS: Record<string, string> = {
  name: 'name',
  policy: 'policy',
  storage: 'partition',
  queued: 'queued_count',
  deferred: 'deferred_count',
  ready: 'ready_count',
  active: 'active_count',
  failed: 'failed_count',
  total: 'total_count',
}

const SCHEDULE_SORT_COLUMNS: Record<string, string> = {
  name: 'name',
  key: 'key',
  cron: 'cron',
  timezone: 'timezone',
}

const WARNING_SORT_COLUMNS: Record<string, string> = {
  type: 'type',
  created: 'created_on',
}

const BAM_SORT_COLUMNS: Record<string, string> = {
  name: 'name',
  version: 'version',
  status: 'status',
  table: 'table_name',
  created: 'created_on',
  started: 'started_on',
  completed: 'completed_on',
}

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
  ready_count as "readyCount",
  active_count as "activeCount",
  failed_count as "failedCount",
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

export function jobColumnPathToSql (path: string): string {
  if (path === 'data' || path === 'output') return path

  if (path.startsWith('data.') || path.startsWith('output.')) {
    const [column, ...segments] = path.split('.')
    return `${column} #>> ARRAY[${segments.map(quoteSqlString).join(',')}]`
  }

  const sql = jobColumnDbColumn(path)
  if (!sql) throw new Error(`Invalid column path: ${path}`)
  return sql
}

export function buildJobColumnProjections (columns: JobColumn[]): string[] {
  const seen = new Set<string>()
  const projections: string[] = []

  for (const col of columns) {
    if (isBuiltinJobColumnPath(col.path)) continue
    const prop = col.path
    if (seen.has(prop)) continue
    seen.add(prop)

    const expr = jobColumnPathToSql(col.path)
    projections.push(`${expr} as ${quoteSqlIdentifier(prop)}`)
  }

  return projections
}

function buildJobListSelect (jobColumns: JobColumn[] = []): string {
  const extra = buildJobColumnProjections(jobColumns)
  if (extra.length === 0) return JOB_LIST_COLUMNS
  return `${JOB_LIST_COLUMNS},\n  ${extra.join(',\n  ')}`
}

function quoteSqlIdentifier (identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function quoteSqlString (value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Get queues with cached stats, with optional pagination, filtering, and search
// Whether queue.ready_history (schema v35+) exists, cached per (db, schema) for the process lifetime.
// Lets the queues list/detail read the always-on sparkline column when present and degrade silently
// on older databases — without a per-row or per-load schema probe.
const readyHistoryColumnCache = new Map<string, boolean>()

// Reset the ready_history capability cache (used by tests).
export function clearReadyHistoryColumnCache (): void {
  readyHistoryColumnCache.clear()
}

async function hasReadyHistoryColumn (dbUrl: string, schema: string): Promise<boolean> {
  const key = `${dbUrl}::${schema}`
  const cached = readyHistoryColumnCache.get(key)
  if (cached !== undefined) return cached

  validateIdentifier(schema)
  const sql = `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'queue' AND column_name = 'ready_history'
    ) as "exists"
  `
  const row = await queryOne<{ exists: boolean }>(dbUrl, sql, [schema])
  const exists = row?.exists ?? false
  readyHistoryColumnCache.set(key, exists)
  return exists
}

// Build the `, ready_history as "readyHistory"` SELECT fragment when the column exists, else ''.
async function readyHistoryColumn (dbUrl: string, schema: string): Promise<string> {
  return (await hasReadyHistoryColumn(dbUrl, schema)) ? ', ready_history as "readyHistory"' : ''
}

export async function getQueues (
  dbUrl: string,
  schema: string,
  options: {
    limit?: number;
    offset?: number;
    filter?: 'all' | 'attention' | 'partitioned';
    search?: string;
  } & SortOptions = {}
): Promise<QueueResult[]> {
  const s = validateIdentifier(schema)
  const readyHistoryCol = await readyHistoryColumn(dbUrl, schema)
  const { limit, offset, filter = 'all', search, sort, dir } = options
  const orderBy = buildOrderBy({ sort, dir }, QUEUE_SORT_COLUMNS, 'name', 'name')

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
      SELECT ${QUEUE_COLUMNS}${readyHistoryCol}
      FROM ${s}.queue
      ${whereClause}
      ${orderBy}
    `
    return query<QueueResult>(dbUrl, sql, params)
  }

  // With pagination
  params.push(limit, offset ?? 0)
  const sql = `
    SELECT ${QUEUE_COLUMNS}${readyHistoryCol}
    FROM ${s}.queue
    ${whereClause}
    ${orderBy}
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
  const readyHistoryCol = await readyHistoryColumn(dbUrl, schema)
  const sql = `
    SELECT ${QUEUE_COLUMNS}${readyHistoryCol}
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
  const readyHistoryCol = await readyHistoryColumn(dbUrl, schema)
  const sql = `
    SELECT ${QUEUE_COLUMNS}${readyHistoryCol}
    FROM ${s}.queue
    WHERE name = $1
  `
  return queryOne<QueueResult>(dbUrl, sql, [name])
}

// UUID v1-v8 / nil — used to short-circuit the id filter on garbage input rather
// than letting Postgres throw 22P02. Mirrors the strictness of the existing
// validateIdentifier helper above.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RecentJobsFilterOptions {
  state?: JobStateFilter | null;
  id?: string | null;
  queues?: string[] | null;
  minRetries?: number | null;
  data?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
}

// Build the shared WHERE fragment used by getRecentJobs and getRecentJobsCount.
// Returns the assembled clause (with leading WHERE if any conditions exist) plus
// the bound params. The caller appends its own LIMIT/OFFSET params after these.
function buildRecentJobsWhere (
  schema: string,
  options: RecentJobsFilterOptions
): { clause: string; params: unknown[]; impossible: boolean } {
  const conditions: string[] = []
  const params: unknown[] = []
  let paramIndex = 1

  const { state = null, id = null, queues = null, minRetries = null, data = null, output = null } = options

  if (state === 'pending') {
    conditions.push("state < 'completed'")
  } else if (state && state !== 'all') {
    conditions.push(`state = $${paramIndex}::${schema}.job_state`)
    params.push(state)
    paramIndex++
  }

  if (id != null && id !== '') {
    if (!UUID_REGEX.test(id)) {
      // No row will ever match a malformed UUID — short-circuit so callers can
      // skip the query entirely.
      return { clause: '', params: [], impossible: true }
    }
    conditions.push(`id = $${paramIndex}::uuid`)
    params.push(id)
    paramIndex++
  }

  if (queues && queues.length > 0) {
    conditions.push(`name = ANY($${paramIndex}::text[])`)
    params.push(queues)
    paramIndex++
  }

  if (minRetries != null && minRetries > 0) {
    conditions.push(`retry_count >= $${paramIndex}::int`)
    params.push(minRetries)
    paramIndex++
  }

  if (data && Object.keys(data).length > 0) {
    conditions.push(`data @> $${paramIndex}::jsonb`)
    params.push(JSON.stringify(data))
    paramIndex++
  }

  if (output && Object.keys(output).length > 0) {
    conditions.push(`output @> $${paramIndex}::jsonb`)
    params.push(JSON.stringify(output))
    paramIndex++
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { clause, params, impossible: false }
}

// Get recent jobs across all queues with pagination
// Uses lightweight columns and includes queue name
export async function getRecentJobs (
  dbUrl: string,
  schema: string,
  options: RecentJobsFilterOptions & {
    limit?: number;
    offset?: number;
    jobColumns?: JobColumn[];
  } = {}
): Promise<JobResult[]> {
  const s = validateIdentifier(schema)
  const { limit = 20, offset = 0, jobColumns = [], ...filters } = options

  const { clause, params, impossible } = buildRecentJobsWhere(s, filters)
  if (impossible) return []

  const limitPlaceholder = `$${params.length + 1}`
  const offsetPlaceholder = `$${params.length + 2}`
  const selectColumns = buildJobListSelect(jobColumns)

  const sql = `
    SELECT ${selectColumns}
    FROM ${s}.job
    ${clause}
    ORDER BY created_on DESC
    LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
  `
  return query<JobResult>(dbUrl, sql, [...params, limit, offset])
}

// Count of jobs matching the same filters as getRecentJobs. Intentionally
// separate so the loader can skip it when no filter is active (an unfiltered
// COUNT(*) on the job table is expensive on large deployments).
export async function getRecentJobsCount (
  dbUrl: string,
  schema: string,
  options: RecentJobsFilterOptions = {}
): Promise<number> {
  const s = validateIdentifier(schema)
  const { clause, params, impossible } = buildRecentJobsWhere(s, options)
  if (impossible) return 0

  const sql = `SELECT COUNT(*)::int as count FROM ${s}.job ${clause}`
  const result = await queryOne<{ count: number }>(dbUrl, sql, params)
  return result?.count ?? 0
}

// Lightweight name-only listing of queues for filter dropdowns. Kept separate
// from getQueues so the multi-select doesn't pull stat columns it never uses.
export async function getQueueNames (
  dbUrl: string,
  schema: string
): Promise<string[]> {
  const s = validateIdentifier(schema)
  const sql = `SELECT name FROM ${s}.queue ORDER BY name`
  const rows = await query<{ name: string }>(dbUrl, sql)
  return rows.map(r => r.name)
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
    jobColumns?: JobColumn[];
  } = {}
): Promise<JobResult[]> {
  const s = validateIdentifier(schema)
  const { state = null, limit = 50, offset = 0, jobColumns = [] } = options
  const selectColumns = buildJobListSelect(jobColumns)

  // Handle 'pending' filter for non-final states
  if (state === 'pending') {
    const sql = `
      SELECT ${selectColumns}
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
      SELECT ${selectColumns}
      FROM ${s}.job
      WHERE name = $1
      ORDER BY created_on DESC
      LIMIT $2 OFFSET $3
    `
    return query<JobResult>(dbUrl, sql, [queueName, limit, offset])
  }

  // Filter by specific state
  const sql = `
    SELECT ${selectColumns}
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
  } & SortOptions = {}
): Promise<WarningResult[]> {
  const s = validateIdentifier(schema)
  const { type = null, limit = 50, offset = 0, sort, dir } = options
  const orderBy = buildOrderBy({ sort, dir }, WARNING_SORT_COLUMNS, 'created_on DESC', 'id DESC')

  const sql = `
    SELECT
      id,
      type,
      message,
      data,
      created_on as "createdOn"
    FROM ${s}.warning
    WHERE ($1::text IS NULL OR type = $1)
    ${orderBy}
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

// Get background async migration (BAM) entries, newest schema version first.
// Mirrors plans.getBamEntries in the pg-boss core (same column aliases).
// Returns [] if the bam table doesn't exist (schema predates async migrations).
export async function getBamEntries (
  dbUrl: string,
  schema: string,
  options: {
    status?: string | null;
    limit?: number;
    offset?: number;
  } & SortOptions = {}
): Promise<BamEntryResult[]> {
  const s = validateIdentifier(schema)
  const { status = null, limit = 200, offset = 0, sort, dir } = options
  const orderBy = buildOrderBy({ sort, dir }, BAM_SORT_COLUMNS, 'version DESC, created_on DESC', 'created_on DESC')

  const sql = `
    SELECT
      id,
      name,
      version,
      status,
      queue,
      table_name as "table",
      command,
      error,
      created_on as "createdOn",
      started_on as "startedOn",
      completed_on as "completedOn"
    FROM ${s}.bam
    WHERE ($1::text IS NULL OR status = $1)
    ${orderBy}
    LIMIT $2 OFFSET $3
  `
  try {
    return await query<BamEntryResult>(dbUrl, sql, [status, limit, offset])
  } catch (err: unknown) {
    // Table doesn't exist - schema predates background async migrations
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return []
    }
    throw err
  }
}

// Get BAM entry count (for pagination), optionally filtered by status.
// Returns 0 if the bam table doesn't exist.
export async function getBamCount (
  dbUrl: string,
  schema: string,
  status?: string | null
): Promise<number> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT COUNT(*)::int as count
    FROM ${s}.bam
    WHERE ($1::text IS NULL OR status = $1)
  `
  try {
    const result = await queryOne<{ count: number }>(dbUrl, sql, [status ?? null])
    return result?.count ?? 0
  } catch (err: unknown) {
    // Table doesn't exist - schema predates background async migrations
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return 0
    }
    throw err
  }
}

// Get aggregated BAM counts grouped by status, for the summary cards and the
// Overview widget. Mirrors plans.getBamStatus in the pg-boss core.
// Returns [] if the bam table doesn't exist.
export async function getBamStatusSummary (
  dbUrl: string,
  schema: string
): Promise<BamStatusSummary[]> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT status, count(*)::int as count, max(created_on) as "lastCreatedOn"
    FROM ${s}.bam
    GROUP BY status
  `
  try {
    return await query<BamStatusSummary>(dbUrl, sql)
  } catch (err: unknown) {
    // Table doesn't exist - schema predates background async migrations
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return []
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
      COALESCE(SUM(ready_count), 0)::int as "totalReady",
      COALESCE(SUM(active_count), 0)::int as "totalActive",
      COALESCE(SUM(failed_count), 0)::int as "totalFailed",
      COALESCE(SUM(total_count), 0)::int as "totalJobs",
      COUNT(*)::int as "queueCount"
    FROM ${s}.queue
  `
  const result = await queryOne<QueueStats>(dbUrl, sql)
  return (
    result ?? {
      totalDeferred: 0,
      totalQueued: 0,
      totalReady: 0,
      totalActive: 0,
      totalFailed: 0,
      totalJobs: 0,
      queueCount: 0,
    }
  )
}

// Per-bucket aggregate over a count column. Mirrors STATS_AGG in src/plans.ts. The function name
// can't be a bind parameter so it's interpolated — safe because callers run `aggregate` through
// resolveAggregate first. Cast back to int so node-postgres returns JS numbers, not numeric strings.
const STATS_AGG = {
  max: (c: string) => `max(${c})::int`,
  min: (c: string) => `min(${c})::int`,
  avg: (c: string) => `round(avg(${c}))::int`,
} as const

export function resolveAggregate (aggregate?: string | null): QueueStatsAggregate {
  return aggregate === 'min' || aggregate === 'avg' ? aggregate : 'max'
}

export interface QueueStatsHistoryOptions {
  from?: Date | null;
  to?: Date | null;
  aggregate?: QueueStatsAggregate | string | null;
  maxDataPoints?: number;
}

// Downsampled history for one queue: group the recorded series into ~maxDataPoints fixed-width
// time buckets and collapse each with `aggregate`. Mirrors plans.getQueueStatsHistoryBucketed
// (auto mode) in the pg-boss core — the epoch-floor bucket key avoids date_bin() (PG14+) so it runs
// on PostgreSQL 13+/CockroachDB/Yugabyte, and buckets align to the Unix epoch so boundaries are
// stable across calls. capturedOn is returned as epoch seconds (float8 → JS number) for charting.
// Returns points ascending by time. [] when queue_stats is absent (schema predates v35).
export async function getQueueStatsHistory (
  dbUrl: string,
  schema: string,
  name: string,
  options: QueueStatsHistoryOptions = {}
): Promise<QueueStatsPoint[]> {
  const s = validateIdentifier(schema)
  const { from = null, to = null } = options
  const agg = STATS_AGG[resolveAggregate(options.aggregate)]
  const maxDataPoints = Number.isInteger(options.maxDataPoints) && (options.maxDataPoints as number) > 0
    ? (options.maxDataPoints as number)
    : 100

  // Inner query keeps the newest maxDataPoints buckets (epoch-aligned bucketing can straddle a
  // boundary and emit one extra), then the outer flips to ascending order for plotting.
  const sql = `
    WITH extent AS (
      SELECT min(captured_on) AS lo, max(captured_on) AS hi
      FROM ${s}.queue_stats
      WHERE name = $1
    ),
    bounds AS (
      SELECT
        greatest(coalesce($2::timestamptz, lo), lo) AS lo,
        least(coalesce($3::timestamptz, hi), hi)    AS hi
      FROM extent
    ),
    w AS (
      SELECT greatest(1, ceil(extract(epoch from (hi - lo)) / greatest($4, 1))::bigint)::bigint AS secs
      FROM bounds
    )
    SELECT * FROM (
      SELECT
        (floor(extract(epoch from captured_on) / w.secs) * w.secs)::float8 as "capturedOn",
        ${agg('deferred_count')} as "deferredCount",
        ${agg('queued_count')}   as "queuedCount",
        ${agg('ready_count')}    as "readyCount",
        ${agg('active_count')}   as "activeCount",
        ${agg('failed_count')}   as "failedCount",
        ${agg('total_count')}    as "totalCount"
      FROM ${s}.queue_stats, w
      WHERE name = $1
        AND ($2::timestamptz IS NULL OR captured_on >= $2)
        AND ($3::timestamptz IS NULL OR captured_on <= $3)
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $4
    ) t
    ORDER BY t."capturedOn" ASC
  `
  try {
    return await query<QueueStatsPoint>(dbUrl, sql, [name, from, to, maxDataPoints])
  } catch (err: unknown) {
    // Table doesn't exist - schema predates queue stats (v35)
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return []
    }
    throw err
  }
}

// Whether queue stats are being collected. The queue_stats table is always created at schema v35;
// only the inserts are gated by persistQueueStats. So "collecting" means the table exists AND holds
// at least one row — which also reads a just-enabled-but-no-snapshot-yet instance as not-yet-active.
// 42P01 → schema predates v35 → unavailable. Drives the StatsDisabledBanner.
export async function getQueueStatsCollectionStatus (
  dbUrl: string,
  schema: string
): Promise<{ available: boolean }> {
  const s = validateIdentifier(schema)
  const sql = `SELECT EXISTS (SELECT 1 FROM ${s}.queue_stats LIMIT 1) as available`
  try {
    const row = await queryOne<{ available: boolean }>(dbUrl, sql)
    return { available: row?.available ?? false }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return { available: false }
    }
    throw err
  }
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
  } & SortOptions = {}
): Promise<ScheduleResult[]> {
  const s = validateIdentifier(schema)
  const { limit, offset, sort, dir } = options
  const orderBy = buildOrderBy({ sort, dir }, SCHEDULE_SORT_COLUMNS, 'name, key', 'name, key')

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
    ${orderBy}
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

// Re-export job action methods from boss.server
export { getJobById, cancelJob, resumeJob, deleteJob } from './boss.server'
