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
  stopped: 'stopped'
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
  /**
   * Enable distributed database mode for use with distributed SQL databases
   * like CockroachDB, YugabyteDB, and Citus.
   *
   * When enabled:
   * - Uses atomic UPDATE instead of SELECT FOR UPDATE SKIP LOCKED for job fetching
   *
   * When to use:
   * - CockroachDB: Required along with noTablePartitioning, noDeferrableConstraints,
   *   noAdvisoryLocks, and noCoveringIndexes
   * - YugabyteDB/Citus: Optional (test both modes for your workload)
   * - PostgreSQL: Not recommended (standard mode is more efficient)
   *
   * Trade-off: Under high contention, some workers may receive empty results
   * as concurrent updates to the same rows will fail the state check.
   *
   * @see https://timgit.github.io/pg-boss/docs/distributed-databases
   * @default false
   */
  distributedDatabaseMode?: boolean;
  /**
   * Disable PostgreSQL-style table partitioning for databases that don't support it.
   *
   * When enabled:
   * - Creates job table without PARTITION BY LIST
   * - All jobs stored in single table instead of partitions
   * - Queue-level partitioning (partition: true) is not supported
   *
   * Required for:
   * - CockroachDB (different partitioning model)
   * - Spanner via PGAdapter (no declarative partitioning support)
   *
   * Not needed for:
   * - PostgreSQL, YugabyteDB, Citus (full partitioning support)
   *
   * @see https://timgit.github.io/pg-boss/docs/distributed-databases
   * @default false
   */
  noTablePartitioning?: boolean;
  /**
   * Disable DEFERRABLE INITIALLY DEFERRED on foreign key constraints.
   *
   * Required for:
   * - CockroachDB (does not support deferrable constraints)
   * - Spanner via PGAdapter (does not support deferrable constraints)
   *
   * Not needed for:
   * - PostgreSQL, YugabyteDB, Citus (full constraint support)
   *
   * @see https://timgit.github.io/pg-boss/docs/distributed-databases
   * @default false
   */
  noDeferrableConstraints?: boolean;
  /**
   * Disable PostgreSQL advisory locks (pg_advisory_xact_lock).
   *
   * Required for:
   * - CockroachDB (does not support advisory locks)
   * - Spanner via PGAdapter (does not support advisory locks)
   *
   * Not needed for:
   * - PostgreSQL, YugabyteDB, Citus (full advisory lock support)
   *
   * Note: Advisory locks are used to prevent race conditions during schema
   * creation and migrations. Without them, CockroachDB relies on SERIALIZABLE
   * isolation for coordination.
   *
   * @see https://timgit.github.io/pg-boss/docs/distributed-databases
   * @default false
   */
  noAdvisoryLocks?: boolean;
  /**
   * Disable covering indexes (INCLUDE clause).
   *
   * Required for:
   * - CockroachDB (implicitly includes PK columns in all indexes, causing
   *   "already contains column" error when explicitly including them)
   * - Spanner via PGAdapter (likely required)
   *
   * Not needed for:
   * - PostgreSQL, YugabyteDB, Citus (full covering index support)
   *
   * @see https://timgit.github.io/pg-boss/docs/distributed-databases
   * @default false
   */
  noCoveringIndexes?: boolean;
}

export interface Migration {
  release: string
  version: number
  previous: number
  install: string[]
  uninstall: string[]
}

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
  __test__force_cron_monitoring_error?: string;
  /** @internal */
  __test__force_clock_skew_warning?: string;
  /** @internal */
  __test__force_clock_monitoring_error?: string;
  /** @internal */
  __test__enableSpies?: boolean;
  /** @internal */
  migrations?: Migration[];
}

export interface ResolvedConstructorOptions extends ConstructorOptions {
  schema: string;
  monitorIntervalSeconds: number;
  cronMonitorIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
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
}

export interface ConnectionOptions {
  db?: IDatabase;
}

export type InsertOptions = ConnectionOptions

export type SendOptions = JobOptions & QueueOptions & ConnectionOptions

export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive' | (string & {})

export interface Queue extends QueueOptions {
  name: string;
  policy?: QueuePolicy;
  partition?: boolean;
  deadLetter?: string;
  warningQueueSize?: number;
}

export interface QueueResult extends Queue {
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

export interface WorkHandler<ReqData, ResData = any> {
  (job: Job<ReqData>[]): Promise<ResData>;
}

export interface WorkWithMetadataHandler<ReqData, ResData = any> {
  (job: JobWithMetadata<ReqData>[]): Promise<ResData>;
}

export interface Request {
  name: string;
  data?: object;
  options?: SendOptions;
}

export interface Schedule {
  name: string;
  key: string;
  cron: string;
  timezone: string;
  data?: object;
  options?: SendOptions;
}

export interface Job<T = object> {
  id: string;
  name: string;
  data: T;
  expireInSeconds: number;
  signal: AbortSignal;
  groupId?: string | null;
  groupTier?: string | null;
}

export interface JobWithMetadata<T = object> extends Job<T> {
  priority: number;
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
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
  output: object;
}

export interface JobInsert<T = object> {
  id?: string;
  data?: T;
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

export type UpdateQueueOptions = Omit<Queue, 'name' | 'partition' | 'policy'>

export interface Warning { message: string, data: object }

export interface CommandResponse {
  /** @internal */
  jobs: string[];
  /** @internal */
  requested: number;
  /** @internal */
  affected: number;
}

export type PgBossEventMap = {
  error: [error: Error]
  warning: [warning: Warning]
  wip: [data: WipData[]]
  stopped: []
}
