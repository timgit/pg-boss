export interface QueueResult {
  name: string;
  policy: string;
  partition: boolean;
  deadLetter: string | null;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax: number | null;
  expireSeconds: number;
  retentionSeconds: number;
  deletionSeconds: number;
  deferredCount: number;
  queuedCount: number;
  activeCount: number;
  totalCount: number;
  warningQueued: number;
  singletonsActive: string[] | null;
  tableName?: string;
  monitorOn: Date | null;
  maintainOn: Date | null;
  createdOn: Date;
  updatedOn: Date;
}

export type JobState =
  | 'created'
  | 'retry'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface JobResult {
  id: string;
  name: string;
  data: unknown;
  state: JobState;
  priority: number;
  retryCount: number;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  startAfter: Date;
  startedOn: Date | null;
  completedOn: Date | null;
  createdOn: Date;
  keepUntil: Date;
  output: unknown;
  singletonKey: string | null;
  groupId: string | null;
  groupTier: string | null;
  deadLetter: string | null;
  policy: string | null;
}

export type WarningType = 'slow_query' | 'queue_backlog' | 'clock_skew'

export interface WarningResult {
  id: number;
  type: WarningType;
  message: string;
  data: unknown;
  createdOn: Date;
}

export interface AggregateStats {
  totalDeferred: number;
  totalQueued: number;
  totalActive: number;
  totalJobs: number;
  queueCount: number;
}
