import { appendSearchParamPairs, parseSearchParamPairs } from './utils'

export interface JobColumn {
  path: string
  name: string
}

const BUILTIN_JOB_COLUMNS = [
  ['id', 'ID', 'id'],
  ['name', 'Queue', 'name'],
  ['state', 'State', 'state'],
  ['retries', 'Retries', 'retries'],
  ['priority', 'Priority', 'priority'],
  ['retryCount', 'Retry count', 'retry_count'],
  ['retryLimit', 'Retry limit', 'retry_limit'],
  ['startAfter', 'Start after', 'start_after'],
  ['startedOn', 'Started', 'started_on'],
  ['completedOn', 'Completed', 'completed_on'],
  ['createdOn', 'Created', 'created_on'],
  ['singletonKey', 'Singleton key', 'singleton_key'],
] as const

const EXTRA_DB_JOB_COLUMNS = [
  ['data', 'Data', 'data'],
  ['output', 'Output', 'output'],
  ['groupId', 'Group ID', 'group_id'],
  ['groupTier', 'Group tier', 'group_tier'],
  ['deadLetter', 'Dead letter', 'dead_letter'],
  ['policy', 'Policy', 'policy'],
] as const

const JOB_COLUMNS = [
  ...BUILTIN_JOB_COLUMNS,
  ...EXTRA_DB_JOB_COLUMNS,
] as const

const DEFAULT_JOB_COLUMN_PATHS = [
  'id',
  'name',
  'state',
  'retries',
  'createdOn',
]

const DEFAULT_QUEUE_JOB_COLUMN_PATHS = [
  'id',
  'state',
  'priority',
  'retries',
  'createdOn',
]

const BUILTIN_COLUMN_PATHS: Set<string> = new Set(BUILTIN_JOB_COLUMNS.map(([path]) => path))

const EXTRA_DB_COLUMN_PATHS: Set<string> = new Set(EXTRA_DB_JOB_COLUMNS.map(([path]) => path))

const JOB_COLUMN_DEFAULT_NAMES = new Map<string, string>(JOB_COLUMNS.map(([path, name]) => [path, name]))

const JOB_COLUMN_DB_COLUMNS = new Map<string, string>(JOB_COLUMNS.map(([path, , dbColumn]) => [path, dbColumn]))

export const DEFAULT_JOB_COLUMNS: JobColumn[] = DEFAULT_JOB_COLUMN_PATHS.map(createKnownJobColumn)

export const DEFAULT_QUEUE_JOB_COLUMNS: JobColumn[] = DEFAULT_QUEUE_JOB_COLUMN_PATHS.map(createKnownJobColumn)

export const JOB_COLUMN_SOURCE_OPTIONS = [
  ...JOB_COLUMNS.map(([path]) => path),
]

export function parseJobColumns (
  params: URLSearchParams,
  defaultColumns: JobColumn[] = DEFAULT_JOB_COLUMNS
): JobColumn[] {
  const columns = parseSearchParamPairs(params, 'col')
    .map(pair => createJobColumn(pair.key, pair.value))
    .filter(column => column != null)

  return columns.length > 0 ? columns : defaultColumns
}

export function appendJobColumns (
  params: URLSearchParams,
  columns: JobColumn[],
  defaultColumns: JobColumn[] = DEFAULT_JOB_COLUMNS
): void {
  params.delete('col')
  if (jobColumnsEqual(columns, defaultColumns)) return

  appendSearchParamPairs(params, 'col', columns.map(column => ({
    key: column.path,
    value: column.name,
  })))
}

export function createJobColumn (path: string, name = ''): JobColumn | null {
  const trimmedPath = path.trim()
  if (!isSupportedJobColumnPath(trimmedPath)) return null

  return {
    path: trimmedPath,
    name: name.trim() || defaultJobColumnName(trimmedPath),
  }
}

export function isBuiltinJobColumnPath (path: string): boolean {
  return BUILTIN_COLUMN_PATHS.has(path)
}

function isSupportedJobColumnPath (path: string): boolean {
  if (BUILTIN_COLUMN_PATHS.has(path) || EXTRA_DB_COLUMN_PATHS.has(path)) return true
  return (path.startsWith('data.') && path !== 'data.') ||
    (path.startsWith('output.') && path !== 'output.')
}

export function getRowCellValue (row: object, prop: string): string | null {
  const value = (row as Record<string, unknown>)[prop]
  if (value == null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function defaultJobColumnName (path: string): string {
  return JOB_COLUMN_DEFAULT_NAMES.get(path) ?? path
}

export function jobColumnDbColumn (path: string): string | null {
  return JOB_COLUMN_DB_COLUMNS.get(path) ?? null
}

function createKnownJobColumn (path: string): JobColumn {
  return {
    path,
    name: defaultJobColumnName(path),
  }
}

function jobColumnsEqual (a: JobColumn[], b: JobColumn[]): boolean {
  if (a.length !== b.length) return false
  return a.every((column, index) => {
    const other = b[index]
    return column.path === other.path && column.name === other.name
  })
}

