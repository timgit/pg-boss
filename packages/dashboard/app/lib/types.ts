// Types based on or imported from pg-boss
import type { JobWithMetadata, QueuePolicy, QueueResult as PgBossQueueResult } from 'pg-boss'
export type { JobWithMetadata, QueuePolicy }

// SendOptions type from pg-boss (defined locally for compatibility)
// Represents options for sending jobs
export type SendOptions = Record<string, any>

// ScheduleOptions type from pg-boss (defined locally for compatibility)
export type ScheduleOptions = SendOptions & { tz?: string; key?: string }

// Schedule interface from pg-boss (defined locally for compatibility)
export interface Schedule {
  name: string;
  key: string;
  cron: string;
  timezone: string;
  data?: object;
  options?: SendOptions;
}

// QueueResult extends pg-boss QueueResult with dashboard-specific fields
export interface QueueResult extends PgBossQueueResult {
  // Dashboard-specific fields for monitoring and maintenance tracking
  monitorOn: Date | null;
  maintainOn: Date | null;
  // Stats fields (declared locally so the dashboard typechecks against older
  // installed pg-boss versions whose published types predate these columns).
  // readyCount = queuedCount - deferredCount (jobs runnable now); failedCount =
  // failed jobs still retained in the table.
  readyCount: number;
  failedCount: number;
}

// JobState is a union type extracted from JobWithMetadata
export type JobState = JobWithMetadata['state']

// JobResult for query results (subset of JobWithMetadata with optional detail fields)
// Always includes: core job metadata for list views
// Optionally includes: data, output, and additional config fields for detail views
export type JobResult =
  // Required fields (always queried for job lists)
  Pick<JobWithMetadata,
    'id' | 'name' | 'state' | 'priority' | 'retryCount' | 'retryLimit' |
    'startAfter' | 'startedOn' | 'completedOn' | 'createdOn' | 'singletonKey'
  > &
  // Optional fields (only queried when needed)
  Partial<Pick<JobWithMetadata,
    'data' | 'output' | 'retryDelay' | 'retryBackoff' | 'keepUntil' |
    'groupId' | 'groupTier' | 'deadLetter' | 'policy'
  >>

export type WarningType = 'slow_query' | 'queue_backlog' | 'clock_skew'

export interface WarningResult {
  id: number;
  type: WarningType;
  message: string;
  data: unknown;
  createdOn: Date;
}

export interface QueueStats {
  totalDeferred: number;
  totalQueued: number;
  totalReady: number;
  totalActive: number;
  totalFailed: number;
  totalJobs: number;
  queueCount: number;
}

// Background async migration (BAM) status. Mirrors src/types.ts in the pg-boss core.
export type BamStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface BamEntryResult {
  id: string;
  name: string;
  version: number;
  status: BamStatus;
  queue: string | null;
  table: string;
  command: string;
  error: string | null;
  createdOn: Date;
  startedOn: Date | null;
  completedOn: Date | null;
}

export interface BamStatusSummary {
  status: BamStatus;
  count: number;
  lastCreatedOn: Date;
}

// ScheduleResult extends Schedule from pg-boss with additional fields
export interface ScheduleResult extends Schedule {
  createdOn: Date;
  updatedOn: Date;
}
