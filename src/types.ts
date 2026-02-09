import type { ErrorObject } from 'serialize-error'

// Source: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#more-recursive-type-aliases
type Json =
  | string
  | number
  | boolean
  | null
  | { [property: string]: Json }
  | Json[]

export type JobStates = {
  created: 'created',
  retry: 'retry',
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed'
}

export type Events = {
  error: 'error',
  warning: 'warning',
  wip: 'wip',
  stopped: 'stopped',
  bam: 'bam'
}

export interface IDatabase {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface DatabaseOptions {
  application_name?: string;
  database?: string;
  user?: string;
  password?: string | (() => string) | (() => Promise<string>);
  host?: string;
  port?: number;
  schema?: string;
  ssl?: any;
  connectionString?: string;
  max?: number;
  db?: IDatabase;
  connectionTimeoutMillis?: number;
  /** @internal */
  debug?: boolean;
}

export interface SchedulingOptions {
  schedule?: boolean;
  clockMonitorIntervalSeconds?: number;
  cronWorkerIntervalSeconds?: number;
  cronMonitorIntervalSeconds?: number;
}

export interface MaintenanceOptions {
  supervise?: boolean;
  migrate?: boolean;
  createSchema?: boolean;
  warningSlowQuerySeconds?: number;
  warningQueueSize?: number;
  superviseIntervalSeconds?: number;
  maintenanceIntervalSeconds?: number;
  queueCacheIntervalSeconds?: number;
  monitorIntervalSeconds?: number;
  bamIntervalSeconds?: number;
}

export interface Migration {
  release: string
  version: number
  previous: number
  install: string[]
  async?: string[]
  uninstall?: string[]
}

// Types which are used internally by this library. Regardless of what the user will provide, these types are part of the possible outputs in the given state.
type InternalJobOutput = {
  created: never;
  retry: never;
  active: never;
  completed: never;
  cancelled: never;
  failed: ErrorObject | string;
}
export type JobsConfig = Record<string, {
  input: object | null | undefined;
  output: {
    [S in JobStates[keyof JobStates]]?: unknown;
  }
}>
export type DefaultJobsConfig = Record<string, {
  input: object | null | undefined,
  output: {
    [S in JobStates[keyof JobStates]]: Json | undefined | void;
  }
}>

// Helper types which should be used in the library.
export type JobNames<C extends JobsConfig> = keyof C & string
export type JobInput<C extends JobsConfig, N extends JobNames<C>> = C[N]['input']
export type JobOutput<C extends JobsConfig, N extends JobNames<C>, S extends keyof JobStates> = InternalJobOutput[S] | (C[N]['output'][S] extends undefined ? void | undefined : C[N]['output'][S])
export type EventConfig<C extends JobsConfig> = Record<string, JobNames<C>>
export type EventNames<C extends JobsConfig, EC extends EventConfig<C>> = keyof EC & string

export interface ConstructorOptions extends DatabaseOptions, SchedulingOptions, MaintenanceOptions {
  /** @internal */
  __test__warn_slow_query?: boolean;
  /** @internal */
  __test__throw_maint?: string;
  /** @internal */
  __test__throw_queueCache?: boolean;
  /** @internal */
  __test__throw_worker?: boolean;
  /** @internal */
  __test__throw_bam?: string;
  /** @internal */
  __test__bypass_bam_interval_check?: boolean;
  /** @internal */
  __test__force_cron_monitoring_error?: string;
  /** @internal */
  __test__force_clock_skew_warning?: string;
  /** @internal */
  __test__force_clock_monitoring_error?: string;
  __test__enableSpies?: boolean;
  /** @internal */
  migrations?: Migration[];
}

export interface ResolvedConstructorOptions extends ConstructorOptions {
  schema: string;
  monitorIntervalSeconds: number;
  cronMonitorIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
  bamIntervalSeconds: number;
}

export interface QueueOptions {
  expireInSeconds?: number;
  retentionSeconds?: number;
  deleteAfterSeconds?: number;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
}

export interface GroupOptions {
  id: string;
  tier?: string;
}

export interface GroupConcurrencyConfig {
  default: number;
  tiers?: Record<string, number>;
}

export interface JobOptions {
  id?: string;
  priority?: number;
  startAfter?: number | string | Date;
  singletonKey?: string;
  singletonSeconds?: number;
  singletonNextSlot?: boolean;
  keepUntil?: number | string | Date;
  group?: GroupOptions;
  deadLetter?: string;
}

export interface ConnectionOptions {
  db?: IDatabase;
}

export interface CompleteOptions extends ConnectionOptions {
  includeQueued?: boolean;
}

export interface FindJobsOptions<C extends JobsConfig, N extends JobNames<C>> extends ConnectionOptions {
  id?: string;
  key?: string;
  data?: Partial<NonNullable<JobInput<C, N>>>;
  queued?: boolean;
}

export type InsertOptions = ConnectionOptions & { returnId?: boolean }

export type SendOptions = JobOptions & QueueOptions & ConnectionOptions

export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive' | (string & {})

export interface Queue<N extends string> extends QueueOptions {
  name: N;
  policy?: QueuePolicy;
  partition?: boolean;
  deadLetter?: string;
  warningQueueSize?: number;
}

export interface QueueResult<N extends string> extends Queue<N> {
  deferredCount: number;
  queuedCount: number;
  activeCount: number;
  totalCount: number
  table: string;
  createdOn: Date;
  updatedOn: Date;
  singletonsActive: string[] | null;
}

export type ScheduleOptions = SendOptions & { tz?: string, key?: string }

export interface JobPollingOptions {
  pollingIntervalSeconds?: number;
}

export interface JobFetchOptions {
  includeMetadata?: boolean;
  priority?: boolean;
  orderByCreatedOn?: boolean;
  batchSize?: number;
  ignoreStartAfter?: boolean;
}

export interface WorkConcurrencyOptions {
  /**
   * Number of workers to spawn for this queue (per-node).
   * Each worker polls and processes jobs independently.
   */
  localConcurrency?: number;
  /**
   * Limit concurrent jobs per group within this node (in-memory tracking).
   * No database overhead. Does not coordinate across nodes.
   */
  localGroupConcurrency?: number | GroupConcurrencyConfig;
  /**
   * Limit concurrent jobs per group globally across all nodes (database tracking).
   * Coordinates across distributed deployments via database queries.
   */
  groupConcurrency?: number | GroupConcurrencyConfig;
}

export type WorkOptions = JobFetchOptions & JobPollingOptions & WorkConcurrencyOptions
export interface FetchGroupConcurrencyOptions {
  groupConcurrency?: number | GroupConcurrencyConfig;
  ignoreGroups?: string[] | null;
}

export type FetchOptions = JobFetchOptions & ConnectionOptions & FetchGroupConcurrencyOptions

export interface ResolvedWorkOptions extends WorkOptions {
  pollingInterval: number;
}

export interface WorkHandler<C extends JobsConfig, N extends JobNames<C>> {
  (job: Job<C, N>[]): Promise<JobOutput<C, N, 'completed'>>;
}

export interface WorkWithMetadataHandler<C extends JobsConfig, N extends JobNames<C>> {
  (job: JobWithMetadata<C, N>[]): Promise<JobOutput<C, N, 'completed'>>;
}
export interface Request<C extends JobsConfig, N extends JobNames<C>> {
  name: N;
  data?: JobInput<C, N>;
  options?: SendOptions;
}

export interface Schedule<C extends JobsConfig, N extends string> {
  name: N;
  key: string;
  cron: string;
  timezone: string;
  data?: JobInput<C, N>;
  options?: SendOptions;
}

export interface Job<C extends JobsConfig, N extends string> {
  id: string;
  name: N;
  data: JobInput<C, N>;
  expireInSeconds: number;
  signal: AbortSignal;
  groupId?: string | null;
  groupTier?: string | null;
}

export type JobWithMetadata<C extends JobsConfig, N extends JobNames<C>> = {
  [S in JobStates[keyof JobStates]]: JobWithMetadataAndState<C, N, S>;
}[JobStates[keyof JobStates]]

export interface JobWithMetadataAndState<C extends JobsConfig, N extends JobNames<C>, S extends JobStates[keyof JobStates]> extends Job<C, N> {
  priority: number;
  state: S;
  retryLimit: number;
  retryCount: number;
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax?: number;
  startAfter: Date;
  startedOn: Date;
  singletonKey: string | null;
  singletonOn: Date | null;
  expireInSeconds: number;
  deleteAfterSeconds: number;
  createdOn: Date;
  completedOn: Date | null;
  keepUntil: Date;
  policy: QueuePolicy;
  deadLetter: string;
  output: JobOutput<C, N, S>;
}

export interface JobInsert<C extends JobsConfig, N extends JobNames<C>> {
  id?: string;
  data?: JobInput<C, N>;
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  startAfter?: number | string | Date;
  singletonKey?: string;
  singletonSeconds?: number;
  expireInSeconds?: number;
  deleteAfterSeconds?: number;
  retentionSeconds?: number;
  group?: GroupOptions;
  deadLetter?: string;
}

export type WorkerState = 'created' | 'active' | 'stopping' | 'stopped'

export interface WipData {
  id: string;
  name: string;
  options: WorkOptions;
  state: WorkerState;
  count: number;
  createdOn: number;
  lastFetchedOn: number | null;
  lastJobStartedOn: number | null;
  lastJobEndedOn: number | null;
  lastJobDuration: number | null;
  lastError: object | null;
  lastErrorOn: number | null;
}

export interface StopOptions {
  close?: boolean;
  graceful?: boolean;
  timeout?: number;
}

export interface OffWorkOptions {
  id?: string,
  wait?: boolean
}

export interface EventsMixin extends NodeJS.EventEmitter {
  events: Record<string, string>;
}

export interface FunctionsMixin {
  functions: Function[];
}

export type UpdateQueueOptions = Omit<Queue<string>, 'name' | 'partition' | 'policy'>

export interface Warning { message: string, data: object }

export interface CommandResponse {
  /** @internal */
  jobs: string[];
  /** @internal */
  requested: number;
  /** @internal */
  affected: number;
}

type BamStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface BamEntry {
  id: string
  name: string
  version: number
  status: BamStatus
  queue?: string
  table: string
  command: string
  error?: string
  createdOn: Date
  startedOn?: Date
  completedOn?: Date
}

export interface BamStatusSummary {
  status: BamStatus
  count: number
  lastCreatedOn: Date
}

export interface BamEvent {
  id: string
  name: string
  status: string
  queue?: string
  table: string
  error?: string
}

export type PgBossEventMap = {
  error: [error: Error]
  warning: [warning: Warning]
  wip: [data: WipData[]]
  stopped: []
  bam: [data: BamEvent]
}
