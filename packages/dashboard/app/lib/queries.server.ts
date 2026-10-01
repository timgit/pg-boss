import { query, queryOne } from './db.server'
import { LATENCY_SLOTS } from './stats'
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
  QueueThroughputPoint,
  QueueThroughputSeries,
  ScheduleResult,
  BamEntryResult,
  BamStatusSummary,
  Instance,
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

// Whether queue_stats has the wait and run time columns (schema v44, pg-boss 12.36), cached per
// (db, schema). Unlike the probes below, a missing answer is only kept for five minutes: a database
// is upgraded under a running dashboard when its application deploys, and the stats pages should
// pick the new columns up without a restart. Present stays present.
const latencyColumnsCache = new Map<string, { exists: boolean, checkedAt: number }>()
const LATENCY_RECHECK_MS = 5 * 60_000

// Reset the latency column capability cache (used by tests).
export function clearLatencyColumnsCache (): void {
  latencyColumnsCache.clear()
}

export async function hasLatencyColumns (dbUrl: string, schema: string): Promise<boolean> {
  const key = `${dbUrl}::${schema}`
  const cached = latencyColumnsCache.get(key)
  if (cached && (cached.exists || Date.now() - cached.checkedAt < LATENCY_RECHECK_MS)) return cached.exists

  validateIdentifier(schema)
  const row = await queryOne<{ exists: boolean }>(dbUrl, `
    SELECT COUNT(*)::int = 3 as "exists"
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'queue_stats'
      AND column_name IN ('wait_bins', 'run_bins', 'ready_oldest_seconds')
  `, [schema])
  const exists = row?.exists ?? false
  latencyColumnsCache.set(key, { exists, checkedAt: Date.now() })
  return exists
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

// Whether schedule.kind and schedule.last_job_id (both schema v41+) exist, cached per (db, schema)
// like the ready_history probe above. One entry covers both columns because one migration added
// them; a database without them reads as a table of cron schedules that have never recorded a job,
// which is what it was before v41.
const scheduleColumnsCache = new Map<string, boolean>()

// Reset the schedule column capability cache (used by tests).
export function clearScheduleColumnsCache (): void {
  scheduleColumnsCache.clear()
}

async function hasScheduleKindColumns (dbUrl: string, schema: string): Promise<boolean> {
  const key = `${dbUrl}::${schema}`
  const cached = scheduleColumnsCache.get(key)
  if (cached !== undefined) return cached

  validateIdentifier(schema)
  const sql = `
    SELECT COUNT(*)::int = 2 as "exists"
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'schedule' AND column_name IN ('kind', 'last_job_id')
  `
  const row = await queryOne<{ exists: boolean }>(dbUrl, sql, [schema])
  const exists = row?.exists ?? false
  scheduleColumnsCache.set(key, exists)
  return exists
}

// Build the `, kind, last_job_id as "lastJobId"` SELECT fragment when the columns exist, else ''.
async function scheduleKindColumns (dbUrl: string, schema: string): Promise<string> {
  return (await hasScheduleKindColumns(dbUrl, schema)) ? ', kind, last_job_id as "lastJobId"' : ''
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

export interface JobPageContext {
  now: Date;
  isDeadLetterQueue: boolean;
}

// What the job page needs beyond the row itself. `now` is the database's clock, because every job
// timestamp comes from it and a browser's clock can be off by more than a live counter can hide.
// A queue is a dead letter queue when at least one queue names it; which ones, and how many, the
// page does not need.
export async function getJobPageContext (
  dbUrl: string,
  schema: string,
  queueName: string
): Promise<JobPageContext> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT now() as now,
      EXISTS (SELECT 1 FROM ${s}.queue WHERE dead_letter = $1) as "isDeadLetterQueue"
  `
  const row = await queryOne<JobPageContext>(dbUrl, sql, [queueName])
  return row ?? { now: new Date(), isDeadLetterQueue: false }
}

// Whether at least one queue names this one as its dead letter queue, for the queue page's header.
export async function isDeadLetterQueue (
  dbUrl: string,
  schema: string,
  queueName: string
): Promise<boolean> {
  const s = validateIdentifier(schema)
  const row = await queryOne<{ exists: boolean }>(
    dbUrl,
    `SELECT EXISTS (SELECT 1 FROM ${s}.queue WHERE dead_letter = $1) as "exists"`,
    [queueName]
  )
  return row?.exists ?? false
}

export interface LinkedJob {
  id: string;
  name: string;
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
  createdOn: Date;
  startedOn: Date | null;
  completedOn: Date | null;
  retryCount: number;
  output: unknown;
}

// A job in another job's lineage, if it still exists. Looked up by (name, id), the primary key, so
// the caller has to know the queue; null covers both "deleted by retention" and "not in that queue".
export async function getLinkedJob (
  dbUrl: string,
  schema: string,
  queueName: string,
  id: string
): Promise<LinkedJob | null> {
  if (!UUID_REGEX.test(id)) return null
  const s = validateIdentifier(schema)
  const sql = `
    SELECT id, name, state,
      created_on as "createdOn",
      started_on as "startedOn",
      completed_on as "completedOn",
      retry_count as "retryCount",
      output
    FROM ${s}.job
    WHERE name = $1 AND id = $2
  `
  return queryOne<LinkedJob>(dbUrl, sql, [queueName, id])
}

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

export interface QueueThroughputOptions {
  from: Date;
  to: Date;
  bucketSeconds: number;
}

// Throughput over [from, to), in fixed epoch-aligned buckets of bucketSeconds, for one queue or,
// with no name, for every queue at once. The counters are bucketed on delta_on, the end of the
// window a pass counted, and the ready gauge on captured_on; core puts delta_on 10 seconds behind
// captured_on, so the two are aggregated apart and joined on queue and bucket. Passes are unevenly
// spaced, so a rate is sum(delta) / sum(delta_seconds), never delta / bucket width. The captured_on
// bound on the counters keeps the index and partition pruning; its 15-minute margin covers the lag
// with room to spare. Only buckets with data come back: the caller fills gaps.
//
// With the v44 columns, each bucket also carries the wait and run histograms of its passes, 48
// counts each, summed slot by slot here, so a bucket comes back as one histogram however many passes
// it covers. A bucket whose passes counted no finished jobs comes back all zeros; one they did not
// measure at all has no row in h and comes back null.
function throughputSql (s: string, oneQueue: boolean, latency: boolean): string {
  const byName = oneQueue ? 'AND name = $4' : ''
  const counterBucket = '(floor(extract(epoch from delta_on) / $3) * $3)::float8'
  const counterWhere = `captured_on >= $1 AND captured_on < $2::timestamptz + interval '15 minutes'
        AND delta_on >= $1 AND delta_on < $2
        AND delta_seconds > 0
        ${byName}`
  const latencyAgg = latency
    ? `,
        max(ready_oldest_seconds) AS ready_oldest_seconds`
    : ''
  const latencyCtes = latency
    ? `,
    slots AS (
      SELECT name, ${counterBucket} AS t, u.slot, sum(u.w)::int AS w, sum(u.r)::int AS r
      FROM ${s}.queue_stats, unnest(wait_bins, run_bins) WITH ORDINALITY AS u(w, r, slot)
      WHERE ${counterWhere}
      GROUP BY 1, 2, 3
    ),
    h AS (
      SELECT
        name,
        t,
        array_agg(w ORDER BY slot) AS wait_bins,
        array_agg(r ORDER BY slot) AS run_bins
      FROM slots
      GROUP BY 1, 2
    )`
    : ''
  const latencyCols = latency
    ? `,
      h.wait_bins                   AS "waitBins",
      h.run_bins                    AS "runBins",
      d.ready_oldest_seconds        AS "readyOldestSeconds"`
    : ''
  const latencyJoin = latency ? '\n    LEFT JOIN h ON h.name = d.name AND h.t = d.t' : ''
  return `
    WITH d AS (
      SELECT
        name,
        ${counterBucket} AS t,
        sum(created_delta)::float8   AS created,
        sum(completed_delta)::float8 AS completed,
        sum(failed_delta)::float8    AS failed,
        sum(delta_seconds)::float8   AS secs${latencyAgg}
      FROM ${s}.queue_stats
      WHERE ${counterWhere}
      GROUP BY 1, 2
    ),
    g AS (
      SELECT
        name,
        (floor(extract(epoch from captured_on) / $3) * $3)::float8 AS t,
        max(ready_count)::int AS ready
      FROM ${s}.queue_stats
      WHERE captured_on >= $1 AND captured_on < $2
        ${byName}
      GROUP BY 1, 2
    )${latencyCtes}
    SELECT
      coalesce(d.name, g.name)      AS name,
      coalesce(d.t, g.t)            AS "bucketStart",
      d.created / d.secs * 60       AS "arrivedPerMin",
      d.completed / d.secs * 60     AS "completedPerMin",
      d.failed / d.secs * 60        AS "failedPerMin",
      g.ready                       AS "readyCount"${latencyCols}
    FROM d FULL JOIN g ON g.name = d.name AND g.t = d.t${latencyJoin}
    ORDER BY 1, 2
  `
}

type ThroughputRow = QueueThroughputPoint & { name: string }

type LatencyRow = ThroughputRow & {
  waitBins?: unknown
  runBins?: unknown
}

// A bucket's summed counts, one per slot: zeros where its passes measured and no job finished, null
// where they did not measure. CockroachDB hands integers over as strings.
function toBins (bins: unknown): number[] | null {
  return Array.isArray(bins) && bins.length === LATENCY_SLOTS ? bins.map(Number) : null
}

async function queryThroughput (
  dbUrl: string,
  schema: string,
  options: QueueThroughputOptions,
  name?: string
): Promise<ThroughputRow[]> {
  const s = validateIdentifier(schema)
  const bucketSeconds = Math.max(1, Math.floor(options.bucketSeconds))
  const params: unknown[] = [options.from, options.to, bucketSeconds]
  if (name !== undefined) params.push(name)
  try {
    const latency = await hasLatencyColumns(dbUrl, schema)
    const rows = await query<LatencyRow>(dbUrl, throughputSql(s, name !== undefined, latency), params)
    if (!latency) return rows
    return rows.map(({ waitBins, runBins, ...row }) => ({
      ...row,
      waitBins: toBins(waitBins),
      runBins: toBins(runBins),
      readyOldestSeconds: row.readyOldestSeconds == null ? null : Number(row.readyOldestSeconds),
    }))
  } catch (err: unknown) {
    // 42P01: no queue_stats (before v35). 42703: no delta columns (before v43).
    if (err && typeof err === 'object' && 'code' in err && (err.code === '42P01' || err.code === '42703')) {
      return []
    }
    throw err
  }
}

// One queue's throughput, buckets ascending. [] before v43 or before v35.
export async function getQueueThroughput (
  dbUrl: string,
  schema: string,
  name: string,
  options: QueueThroughputOptions
): Promise<QueueThroughputPoint[]> {
  const rows = await queryThroughput(dbUrl, schema, options, name)
  return rows.map(({ name: _name, ...point }) => point)
}

// Every queue's throughput in one query, for the /stats overview: one entry per queue that has
// stats in the window, by name, buckets ascending. A queue with no rows in the window is absent.
export async function getThroughputOverview (
  dbUrl: string,
  schema: string,
  options: QueueThroughputOptions
): Promise<QueueThroughputSeries[]> {
  const series: QueueThroughputSeries[] = []
  for (const { name, ...point } of await queryThroughput(dbUrl, schema, options)) {
    const last = series[series.length - 1]
    if (last?.name === name) last.points.push(point)
    else series.push({ name, points: [point] })
  }
  return series
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

// The instance registry (schema v44+) as core's getInstances() reads it, with the database's clock
// so the page judges ages against the same time the live column did. 42P01 is a schema that
// predates the registry.
export async function getInstanceRegistry (
  dbUrl: string,
  schema: string
): Promise<{ available: boolean, instances: Instance[], checkedOn: Date }> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT
      id,
      name,
      host,
      pid,
      version,
      node_version as "nodeVersion",
      application_name as "applicationName",
      heartbeat_seconds as "heartbeatSeconds",
      supervise,
      schedule,
      migrate,
      persist_queue_stats as "persistQueueStats",
      persist_warnings as "persistWarnings",
      pool_max as "poolMax",
      pool_total as "poolTotal",
      pool_idle as "poolIdle",
      pool_waiting as "poolWaiting",
      workers,
      metrics,
      config,
      crash_restarts as "crashRestarts",
      crash_restarts_since as "crashRestartsSince",
      started_on as "startedOn",
      heartbeat_on as "heartbeatOn",
      stopped_on as "stoppedOn",
      stopped_on IS NULL AND heartbeat_on >= ${s}.job_now() - heartbeat_seconds * 3 * interval '1 second' as live,
      ${s}.job_now() as "checkedOn"
    FROM ${s}.instance
    ORDER BY started_on, id
  `
  try {
    const rows = await query<Instance & { checkedOn: Date }>(dbUrl, sql)
    // CockroachDB returns its INT8 columns as strings, and its jsonb as text through some drivers.
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
    const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
    const checkedOn = rows[0]?.checkedOn ?? (await queryOne<{ now: Date }>(dbUrl, `SELECT ${s}.job_now() as now`))!.now
    return {
      available: true,
      checkedOn: new Date(checkedOn),
      instances: rows.map(({ checkedOn: _c, ...row }) => ({
        ...row,
        pid: Number(row.pid),
        heartbeatSeconds: Number(row.heartbeatSeconds),
        poolMax: num(row.poolMax),
        poolTotal: num(row.poolTotal),
        poolIdle: num(row.poolIdle),
        poolWaiting: num(row.poolWaiting),
        workers: json(row.workers) ?? [],
        metrics: json(row.metrics),
        config: json(row.config) ?? {},
        crashRestarts: Number(row.crashRestarts),
      })),
    }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return { available: false, instances: [], checkedOn: new Date() }
    }
    throw err
  }
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
  const kindColumns = await scheduleKindColumns(dbUrl, schema)

  const sql = `
    SELECT
      name,
      key,
      cron,
      timezone,
      data,
      options,
      created_on as "createdOn",
      updated_on as "updatedOn"${kindColumns}
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
  const kindColumns = await scheduleKindColumns(dbUrl, schema)
  const sql = `
    SELECT
      name,
      key,
      cron,
      timezone,
      data,
      options,
      created_on as "createdOn",
      updated_on as "updatedOn"${kindColumns}
    FROM ${s}.schedule
    WHERE name = $1 AND key = $2
  `

  return await queryOne<ScheduleResult>(dbUrl, sql, [name, key])
}

// Re-exported so routes read jobs through one module
export { getJobById } from './boss.server'
