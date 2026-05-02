// Shared utility functions for the dashboard

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn (...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse and validate a page number from URL search params
 * Returns 1 for invalid/missing values
 */
export function parsePageNumber (value: string | null): number {
  if (!value) return 1
  const parsed = parseInt(value, 10)
  if (isNaN(parsed) || parsed < 1) return 1
  return parsed
}

/**
 * Format a date as a relative time string (e.g., "5m ago", "2h ago")
 */
export function formatTimeAgo (date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/**
 * Format a date for display in tables/lists
 */
export function formatDate (date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Format a date with seconds for warnings/logs
 */
export function formatDateWithSeconds (date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

// Valid job states
export const JOB_STATES = [
  'created',
  'retry',
  'active',
  'completed',
  'cancelled',
  'failed',
] as const

export type JobStateValue = (typeof JOB_STATES)[number]

// Special filters
export const PENDING_FILTER = 'pending' as const // Non-final states (created, retry, active)
export const ALL_STATES_FILTER = 'all' as const // All states (no filter)
export const DEFAULT_STATE_FILTER = PENDING_FILTER // Default filter when none specified

export type JobStateFilter = JobStateValue | typeof PENDING_FILTER | typeof ALL_STATES_FILTER

/**
 * Validate a job state filter value
 * Accepts individual states, 'pending' for non-final states, or 'all' for all states
 */
export function isValidJobState (value: string | null): value is JobStateFilter | null {
  if (value === null) return true
  if (value === PENDING_FILTER) return true
  if (value === ALL_STATES_FILTER) return true
  return JOB_STATES.includes(value as JobStateValue)
}

// Badge variant mappings for job states
type BadgeVariant = 'gray' | 'primary' | 'success' | 'warning' | 'error'

export const JOB_STATE_VARIANTS: Record<JobStateValue, BadgeVariant> = {
  created: 'gray',
  retry: 'warning',
  active: 'primary',
  completed: 'success',
  cancelled: 'gray',
  failed: 'error',
}

// Filter options for job states (for dropdowns)
export const JOB_STATE_OPTIONS: { value: JobStateFilter; label: string }[] = [
  { value: ALL_STATES_FILTER, label: 'All States' },
  { value: PENDING_FILTER, label: 'Pending' },
  ...JOB_STATES.map((state) => ({
    value: state,
    label: state.charAt(0).toUpperCase() + state.slice(1),
  })),
]

// Maximum number of key=value rows accepted per JSON filter (data / output).
// Bounded to keep the resulting JSONB payload and URL length reasonable.
export const MAX_JSON_FILTER_PAIRS = 10

export interface JsonFilterPair {
  key: string;
  value: string;
}

/**
 * Parse JSONB filter rows from URL search params for a given prefix
 * (e.g. 'data' → reads every `data.<key>` param). Order is stable based on
 * URLSearchParams insertion order so the UI can re-render the same pair list.
 */
export function parseJsonFilterPairs (
  searchParams: URLSearchParams,
  prefix: 'data' | 'output'
): JsonFilterPair[] {
  const pairs: JsonFilterPair[] = []
  const dotPrefix = `${prefix}.`
  for (const [paramKey, paramValue] of searchParams.entries()) {
    if (!paramKey.startsWith(dotPrefix)) continue
    const key = paramKey.slice(dotPrefix.length)
    if (!key) continue
    pairs.push({ key, value: paramValue })
    if (pairs.length >= MAX_JSON_FILTER_PAIRS) break
  }
  return pairs
}

/**
 * Convert key=value rows to the object passed to the server's @> filter.
 * Numeric and boolean strings are coerced so `value=1234` matches the wrapped
 * `{"value": 1234}` payload pg-boss stores for primitive job data.
 */
export function jsonFilterPairsToObject (pairs: JsonFilterPair[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { key, value } of pairs) {
    if (!key) continue
    out[key] = coerceJsonScalar(value)
  }
  return out
}

function coerceJsonScalar (value: string): string | number | boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== '' && !isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value)
  }
  return value
}

// Valid warning types
export const WARNING_TYPES = [
  'slow_query',
  'queue_backlog',
  'clock_skew',
] as const

export type WarningTypeValue = (typeof WARNING_TYPES)[number]

/**
 * Validate a warning type filter value
 */
export function isValidWarningType (value: string | null): value is WarningTypeValue | null {
  if (value === null) return true
  return WARNING_TYPES.includes(value as WarningTypeValue)
}

// Badge variant mappings for warning types
export const WARNING_TYPE_VARIANTS: Record<WarningTypeValue, BadgeVariant> = {
  slow_query: 'warning',
  queue_backlog: 'error',
  clock_skew: 'gray',
}

// Human-readable labels for warning types
export const WARNING_TYPE_LABELS: Record<WarningTypeValue, string> = {
  slow_query: 'Slow Query',
  queue_backlog: 'Queue Backlog',
  clock_skew: 'Clock Skew',
}

// Filter options for warning types (for dropdowns)
export const WARNING_TYPE_OPTIONS: { value: WarningTypeValue | null; label: string }[] = [
  { value: null, label: 'All Types' },
  ...WARNING_TYPES.map((type) => ({
    value: type,
    label: WARNING_TYPE_LABELS[type],
  })),
]

/**
 * Format warning data for display
 */
export function formatWarningData (data: unknown): string {
  if (!data) return '-'
  if (typeof data === 'string') return data
  try {
    const obj = data as Record<string, unknown>
    const parts: string[] = []

    if (obj.elapsed) parts.push(`${(obj.elapsed as number).toFixed(2)}s`)
    if (obj.name) parts.push(`queue: ${obj.name}`)
    if (obj.queuedCount) parts.push(`queued: ${obj.queuedCount}`)
    if (obj.seconds) parts.push(`skew: ${(obj.seconds as number).toFixed(1)}s`)
    if (obj.direction) parts.push(`(${obj.direction})`)

    return parts.length > 0 ? parts.join(', ') : JSON.stringify(data)
  } catch {
    return String(data)
  }
}
