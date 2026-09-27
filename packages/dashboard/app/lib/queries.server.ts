import { query, queryOne } from './db.server'
import {
  cursorSelect,
  keysetCondition,
  keysetOrderBy,
  keysetPage,
  type Cursor,
  type Key,
  type KeyType,
  type KeysetPage,
} from './keyset.server'
import { isFinishedStateFilter, type JobStateFilter } from './utils'
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

interface SortColumn {
  expr: string;
  type: KeyType;
}

// Map a UI sort key + direction into the keys a list orders and pages by. The key is resolved to a
// real column through an allowlist (so it can never inject), the direction is constrained to
// ASC/DESC, and the tiebreak keys make the ordering unique, which keyset paging needs. Unknown keys
// fall back to the list's default ordering.
function sortKeys (
  { sort, dir }: SortOptions,
  columns: Record<string, SortColumn>,
  defaults: Key[],
  tiebreak: Key[]
): Key[] {
  const column = sort ? columns[sort] : undefined
  if (!column) return defaults
  return [
    { ...column, desc: dir === 'desc' },
    ...tiebreak.filter(k => k.expr !== column.expr),
  ]
}

// Per-list allowlists mapping sort keys (used in the URL + column headers) to real columns. A
// nullable column is coalesced, since a keyset comparison against null matches nothing; the
// fallbacks keep the order Postgres gives nulls (last ascending, first descending).
const QUEUE_SORT_COLUMNS: Record<string, SortColumn> = {
  name: { expr: 'name', type: 'text' },
  policy: { expr: 'policy', type: 'text' },
  storage: { expr: 'partition', type: 'bool' },
  queued: { expr: 'queued_count', type: 'int' },
  deferred: { expr: 'deferred_count', type: 'int' },
  ready: { expr: 'ready_count', type: 'int' },
  active: { expr: 'active_count', type: 'int' },
  failed: { expr: 'failed_count', type: 'int' },
  total: { expr: 'total_count', type: 'int' },
}

// A null timezone is UTC to the core's scheduler, so it sorts as UTC.
const SCHEDULE_SORT_COLUMNS: Record<string, SortColumn> = {
  name: { expr: 'name', type: 'text' },
  key: { expr: 'key', type: 'text' },
  cron: { expr: 'cron', type: 'text' },
  timezone: { expr: "COALESCE(timezone, 'UTC')", type: 'text' },
}

const WARNING_SORT_COLUMNS: Record<string, SortColumn> = {
  type: { expr: 'type', type: 'text' },
  created: { expr: 'created_on', type: 'timestamptz' },
}

const BAM_SORT_COLUMNS: Record<string, SortColumn> = {
  name: { expr: 'name', type: 'text' },
  version: { expr: 'version', type: 'int' },
  status: { expr: 'status', type: 'text' },
  table: { expr: 'table_name', type: 'text' },
  created: { expr: 'created_on', type: 'timestamptz' },
  started: { expr: "COALESCE(started_on, 'infinity'::timestamptz)", type: 'timestamptz' },
  completed: { expr: "COALESCE(completed_on, 'infinity'::timestamptz)", type: 'timestamptz' },
}

const QUEUE_KEYS: Key[] = [{ expr: 'name', type: 'text', desc: false }]
const SCHEDULE_KEYS: Key[] = [{ expr: 'name', type: 'text', desc: false }, { expr: 'key', type: 'text', desc: false }]
const WARNING_KEYS: Key[] = [{ expr: 'created_on', type: 'timestamptz', desc: true }, { expr: 'id', type: 'uuid', desc: true }]
const BAM_TIEBREAK: Key[] = [{ expr: 'created_on', type: 'timestamptz', desc: true }, { expr: 'id', type: 'uuid', desc: true }]
const BAM_KEYS: Key[] = [{ expr: 'version', type: 'int', desc: true }, ...BAM_TIEBREAK]

// Newest first. Jobs written in one transaction share created_on, so id breaks the tie.
const QUEUE_JOB_KEYS: Key[] = [{ expr: 'created_on', type: 'timestamptz', desc: true }, { expr: 'id', type: 'uuid', desc: true }]
const QUEUE_FINISHED_JOB_KEYS: Key[] = [{ expr: 'completed_on', type: 'timestamptz', desc: true }, { expr: 'id', type: 'uuid', desc: true }]

// A finished state lists newest finished first through job_i16 (name, completed_on). Ordered by
// created_on, a queue whose newest jobs are a backlog would read the whole backlog to find them.
// Every path that finishes a job sets completed_on; the condition lets the planner use the index.
const FINISHED_CONDITION = 'completed_on IS NOT NULL'

// A list page: the rows plus its paging, as a loader hands it to the page.
export type ListPage<T> = KeysetPage<T>

const EMPTY_PAGE = { rows: [], hasNextPage: false, hasPrevPage: false, nextCursor: null, prevCursor: null, atStart: true }

export interface PageOptions {
  limit: number;
  cursor?: Cursor;
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

// Build the WHERE conditions the queues list and its count share.
function queueListConditions (
  filter: 'all' | 'attention' | 'partitioned',
  search: string | undefined
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter === 'attention') {
    conditions.push('warning_queued > 0 AND queued_count > warning_queued')
  } else if (filter === 'partitioned') {
    conditions.push('partition = true')
  }

  if (search && search.trim()) {
    params.push(`%${search.trim()}%`)
    conditions.push(`name ILIKE $${params.length}`)
  }

  return { conditions, params }
}

// One page of the queues list, filtered, searched and sorted.
export async function getQueuePage (
  dbUrl: string,
  schema: string,
  options: PageOptions & {
    filter?: 'all' | 'attention' | 'partitioned';
    search?: string;
  } & SortOptions
): Promise<ListPage<QueueResult>> {
  const s = validateIdentifier(schema)
  const readyHistoryCol = await readyHistoryColumn(dbUrl, schema)
  const { limit, cursor = {}, filter = 'all', search, sort, dir } = options
  const keys = sortKeys({ sort, dir }, QUEUE_SORT_COLUMNS, QUEUE_KEYS, QUEUE_KEYS)

  return keysetPage<QueueResult>(keys, cursor, limit, (plan) => {
    const { conditions, params } = queueListConditions(filter, search)
    if (plan.values) {
      conditions.push(keysetCondition(keys, params.length + 1, plan.backward))
      params.push(...plan.values)
    }
    params.push(limit + 1)
    const sql = `
      SELECT ${QUEUE_COLUMNS}${readyHistoryCol}, ${cursorSelect(keys)}
      FROM ${s}.queue
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ${keysetOrderBy(keys, plan.backward)}
      LIMIT $${params.length}
    `
    return query(dbUrl, sql, params)
  })
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
  const { conditions, params } = queueListConditions(filter, search)

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

// The pending filter spelled as a list, not state < 'completed', so the planner can prove it implies
// job_i14's live-state predicate and read a queue's live jobs through it instead of its whole history.
const PENDING_CONDITION = "state IN ('created', 'retry', 'active')"

// Build the WHERE fragment getRecentJobs filters by.
// Returns the assembled clause (with leading WHERE if any conditions exist) plus
// the bound params. The caller appends its own LIMIT/OFFSET params after these.
function buildRecentJobsWhere (
  schema: string,
  options: RecentJobsFilterOptions
): { clause: string; conditions: string[]; params: unknown[]; impossible: boolean } {
  const conditions: string[] = []
  const params: unknown[] = []
  let paramIndex = 1

  const { state = null, id = null, queues = null, minRetries = null, data = null, output = null } = options

  if (state === 'pending') {
    conditions.push(PENDING_CONDITION)
  } else if (state && state !== 'all') {
    conditions.push(`state = $${paramIndex}::${schema}.job_state`)
    params.push(state)
    paramIndex++
  }

  if (id != null && id !== '') {
    if (!UUID_REGEX.test(id)) {
      // No row will ever match a malformed UUID — short-circuit so callers can
      // skip the query entirely.
      return { clause: '', conditions: [], params: [], impossible: true }
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
  return { clause, conditions, params, impossible: false }
}

// Newest first across queues. The same id can sit in two queues (a redrive keeps it), so name ends
// the tie. The inner keys order each queue's own jobs; the outer ones are the same columns as the
// lateral subquery projects them.
const RECENT_JOB_KEYS: Key[] = [
  { expr: 'created_on', type: 'timestamptz', desc: true },
  { expr: 'id', type: 'uuid', desc: true },
  { expr: 'name', type: 'text', desc: true },
]
const RECENT_JOB_PAGE_KEYS: Key[] = [
  { expr: 'j."createdOn"', type: 'timestamptz', desc: true },
  { expr: 'j.id', type: 'uuid', desc: true },
  { expr: 'j.name', type: 'text', desc: true },
]
const FINISHED_JOB_KEYS: Key[] = [
  { expr: 'completed_on', type: 'timestamptz', desc: true },
  { expr: 'id', type: 'uuid', desc: true },
  { expr: 'name', type: 'text', desc: true },
]
const FINISHED_JOB_PAGE_KEYS: Key[] = [
  { expr: 'j."completedOn"', type: 'timestamptz', desc: true },
  { expr: 'j.id', type: 'uuid', desc: true },
  { expr: 'j.name', type: 'text', desc: true },
]

// One page of recent jobs across queues. No index orders the job table by created_on alone, so each
// queue reads its own next page through job_i15 (name, created_on), job_i14 for live states or
// job_i16 for finished ones, and the pages are merged. That costs an index descent per queue, where a whole-table scan would cost a
// read of every job on every page view.
export async function getRecentJobs (
  dbUrl: string,
  schema: string,
  options: RecentJobsFilterOptions & PageOptions & {
    jobColumns?: JobColumn[];
  }
): Promise<ListPage<JobResult>> {
  const s = validateIdentifier(schema)
  const { limit, cursor = {}, jobColumns = [], ...filters } = options
  const selectColumns = buildJobListSelect(jobColumns)

  const { conditions: jobConditions, params: filterParams, impossible } = buildRecentJobsWhere(s, filters)
  if (impossible) return EMPTY_PAGE

  const finished = isFinishedStateFilter(filters.state)
  const keys = finished ? FINISHED_JOB_KEYS : RECENT_JOB_KEYS
  const pageKeys = finished ? FINISHED_JOB_PAGE_KEYS : RECENT_JOB_PAGE_KEYS

  return keysetPage<JobResult>(pageKeys, cursor, limit, (plan) => {
    const params = [...filterParams]
    const conditions = ['name = q.name', ...jobConditions]
    if (finished) conditions.push(FINISHED_CONDITION)
    if (plan.values) {
      conditions.push(keysetCondition(keys, params.length + 1, plan.backward))
      params.push(...plan.values)
    }
    const queueFilter = filters.queues && filters.queues.length > 0
      ? `WHERE q.name = ANY($${params.push(filters.queues)}::text[])`
      : ''
    const limitParam = `$${params.push(limit + 1)}`

    const sql = `
      SELECT j.*, ${cursorSelect(pageKeys)}
      FROM ${s}.queue q
      CROSS JOIN LATERAL (
        SELECT ${selectColumns}
        FROM ${s}.job
        WHERE ${conditions.join(' AND ')}
        ${keysetOrderBy(keys, plan.backward)}
        LIMIT ${limitParam}
      ) j
      ${queueFilter}
      ${keysetOrderBy(pageKeys, plan.backward)}
      LIMIT ${limitParam}
    `
    return query(dbUrl, sql, params)
  })
}

// Every queue name, for the queue pickers on the Jobs filter and the send, schedule and create forms.
export async function getQueueNames (
  dbUrl: string,
  schema: string
): Promise<string[]> {
  const s = validateIdentifier(schema)
  const sql = `SELECT name FROM ${s}.queue ORDER BY name`
  const rows = await query<{ name: string }>(dbUrl, sql)
  return rows.map(r => r.name)
}

// One page of a queue's jobs, newest first, through job_i15 (name, created_on), or newest finished
// first through job_i16 (name, completed_on) for a finished state.
// Uses lightweight columns to avoid loading large payloads
// For counts, we use cached stats from the queue table instead of COUNT(*).
// Supports 'pending' filter for non-final states (created, retry, active)
// Supports 'all' filter for all states (no filtering)
export async function getJobs (
  dbUrl: string,
  schema: string,
  queueName: string,
  options: PageOptions & {
    state?: string | null;
    jobColumns?: JobColumn[];
  }
): Promise<ListPage<JobResult>> {
  const s = validateIdentifier(schema)
  const { state = null, limit, cursor = {}, jobColumns = [] } = options
  const selectColumns = buildJobListSelect(jobColumns)

  const finished = isFinishedStateFilter(state)
  const keys = finished ? QUEUE_FINISHED_JOB_KEYS : QUEUE_JOB_KEYS

  return keysetPage<JobResult>(keys, cursor, limit, (plan) => {
    const params: unknown[] = [queueName]
    const conditions = ['name = $1']
    if (state === 'pending') {
      conditions.push(PENDING_CONDITION)
    } else if (state !== 'all' && state !== null) {
      conditions.push(`state = $${params.push(state)}::${s}.job_state`)
    }
    if (finished) conditions.push(FINISHED_CONDITION)
    if (plan.values) {
      conditions.push(keysetCondition(keys, params.length + 1, plan.backward))
      params.push(...plan.values)
    }
    params.push(limit + 1)

    const sql = `
      SELECT ${selectColumns}, ${cursorSelect(keys)}
      FROM ${s}.job
      WHERE ${conditions.join(' AND ')}
      ${keysetOrderBy(keys, plan.backward)}
      LIMIT $${params.length}
    `
    return query(dbUrl, sql, params)
  })
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

function isMissingTable (err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === '42P01'
}

// One page of warnings, filtered by type and sorted.
// Returns an empty page if the warning table doesn't exist (persistWarnings not enabled)
export async function getWarnings (
  dbUrl: string,
  schema: string,
  options: PageOptions & {
    type?: string | null;
  } & SortOptions
): Promise<ListPage<WarningResult>> {
  const s = validateIdentifier(schema)
  const { type = null, limit, cursor = {}, sort, dir } = options
  const keys = sortKeys({ sort, dir }, WARNING_SORT_COLUMNS, WARNING_KEYS, [WARNING_KEYS[1]])

  try {
    return await keysetPage<WarningResult>(keys, cursor, limit, (plan) => {
      const params: unknown[] = [type]
      const conditions = ['($1::text IS NULL OR type = $1)']
      if (plan.values) {
        conditions.push(keysetCondition(keys, params.length + 1, plan.backward))
        params.push(...plan.values)
      }
      params.push(limit + 1)
      const sql = `
        SELECT
          id,
          type,
          message,
          data,
          created_on as "createdOn",
          ${cursorSelect(keys)}
        FROM ${s}.warning
        WHERE ${conditions.join(' AND ')}
        ${keysetOrderBy(keys, plan.backward)}
        LIMIT $${params.length}
      `
      return query(dbUrl, sql, params)
    })
  } catch (err: unknown) {
    if (isMissingTable(err)) return EMPTY_PAGE
    throw err
  }
}

// Most warnings getWarningCount counts before it stops and reports the count as capped. Nothing
// deletes warnings unless warningRetentionDays is set, so the table can grow without bound.
export const WARNING_COUNT_CAP = 10_000

// Warning count for the page header, up to `cap`.
// Returns 0 if warning table doesn't exist (persistWarnings not enabled)
export async function getWarningCount (
  dbUrl: string,
  schema: string,
  type?: string | null,
  cap: number = WARNING_COUNT_CAP
): Promise<{ count: number; capped: boolean }> {
  const s = validateIdentifier(schema)
  const sql = `
    SELECT COUNT(*)::int as count
    FROM (SELECT 1 FROM ${s}.warning WHERE ($1::text IS NULL OR type = $1) LIMIT $2) t
  `
  try {
    const count = (await queryOne<{ count: number }>(dbUrl, sql, [type ?? null, cap + 1]))?.count ?? 0
    return count > cap ? { count: cap, capped: true } : { count, capped: false }
  } catch (err: unknown) {
    if (isMissingTable(err)) return { count: 0, capped: false }
    throw err
  }
}

// One page of background async migration (BAM) entries, newest schema version first.
// Mirrors plans.getBamEntries in the pg-boss core (same column aliases).
// Returns an empty page if the bam table doesn't exist (schema predates async migrations).
export async function getBamEntries (
  dbUrl: string,
  schema: string,
  options: PageOptions & {
    status?: string | null;
  } & SortOptions
): Promise<ListPage<BamEntryResult>> {
  const s = validateIdentifier(schema)
  const { status = null, limit, cursor = {}, sort, dir } = options
  const keys = sortKeys({ sort, dir }, BAM_SORT_COLUMNS, BAM_KEYS, BAM_TIEBREAK)

  try {
    return await keysetPage<BamEntryResult>(keys, cursor, limit, (plan) => {
      const params: unknown[] = [status]
      const conditions = ['($1::text IS NULL OR status = $1)']
      if (plan.values) {
        conditions.push(keysetCondition(keys, params.length + 1, plan.backward))
        params.push(...plan.values)
      }
      params.push(limit + 1)
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
          completed_on as "completedOn",
          ${cursorSelect(keys)}
        FROM ${s}.bam
        WHERE ${conditions.join(' AND ')}
        ${keysetOrderBy(keys, plan.backward)}
        LIMIT $${params.length}
      `
      return query(dbUrl, sql, params)
    })
  } catch (err: unknown) {
    if (isMissingTable(err)) return EMPTY_PAGE
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

// One page of schedules, sorted.
export async function getSchedules (
  dbUrl: string,
  schema: string,
  options: PageOptions & SortOptions
): Promise<ListPage<ScheduleResult>> {
  const s = validateIdentifier(schema)
  const { limit, cursor = {}, sort, dir } = options
  const keys = sortKeys({ sort, dir }, SCHEDULE_SORT_COLUMNS, SCHEDULE_KEYS, SCHEDULE_KEYS)
  const kindColumns = await scheduleKindColumns(dbUrl, schema)

  return keysetPage<ScheduleResult>(keys, cursor, limit, (plan) => {
    const params: unknown[] = []
    const where = plan.values ? `WHERE ${keysetCondition(keys, 1, plan.backward)}` : ''
    if (plan.values) params.push(...plan.values)
    params.push(limit + 1)
    const sql = `
      SELECT
        name,
        key,
        cron,
        timezone,
        data,
        options,
        created_on as "createdOn",
        updated_on as "updatedOn"${kindColumns},
        ${cursorSelect(keys)}
      FROM ${s}.schedule
      ${where}
      ${keysetOrderBy(keys, plan.backward)}
      LIMIT $${params.length}
    `
    return query(dbUrl, sql, params)
  })
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

// Re-export job action methods from boss.server
export { getJobById, cancelJob, retryJob, resumeJob, deleteJob } from './boss.server'
