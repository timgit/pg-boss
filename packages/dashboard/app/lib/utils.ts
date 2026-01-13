// Shared utility functions for the dashboard

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

/**
 * Validate a job state filter value
 */
export function isValidJobState (value: string | null): value is JobStateValue | null {
  if (value === null) return true
  return JOB_STATES.includes(value as JobStateValue)
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
