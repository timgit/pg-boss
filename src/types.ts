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
  bam: 'bam',
  flow: 'flow'
}

export interface IDatabase {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  /**
   * Optional capability for LISTEN/NOTIFY support. When present, pg-boss can hold a
   * dedicated session-pinned connection to receive notifications. The built-in pool-based
   * Db implements this; custom adapters may implement it to enable `useListenNotify`.
   * Must invoke `onReconnect` after each successful (re)subscribe so missed notifications
   * can be recovered. Returns a handle whose `close()` tears down the listener.
   */
  listen?(channel: string, onNotification: (payload: string) => void, onReconnect: () => void): Promise<ListenHandle>;
}

export interface ListenHandle {
  close(): Promise<void>;
}

export interface DatabaseOptions {
  application_name?: string;
  database?: string;
  user?: string;
  password?: string | (() => string | Promise<string>);
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

/**
 * A named database backend. Selecting a backend turns on the internal compatibility
 * behavior it needs (`noSkipLocked`, `noMultiMutationCte`, `noTablePartitioning`, etc.).
 * Those flags are derived from the backend and are not individually configurable.
 *
 * Backends fall into three kinds — standard, distributed, and embedded:
 * - `postgres` (default): standard PostgreSQL, all flags off.
 * - `cockroachdb`: distributed; enables `noSkipLocked`, `noMultiMutationCte`, `noListenNotify`, and all four `no*` schema gates.
 * - `yugabytedb`: distributed; enables `noAdvisoryLocks` and `noTablePartitioning`. Supports cluster-wide
 *   LISTEN/NOTIFY (early access, off by default — enable the `ysql_yb_enable_listen_notify` flag).
 * - `citus`: distributed; plain PostgreSQL behavior (Citus tables stay coordinator-local); LISTEN/NOTIFY works on the coordinator.
 * - `pglite`: embedded (NOT distributed) single-connection WASM PostgreSQL, all gates off; supports in-process LISTEN/NOTIFY.
 *
 * Spanner, Aurora DSQL, and other targets do not have a profile yet and are not
 * supported. @see https://timgit.github.io/pg-boss/docs/database-backends
 */
export type BackendProfile = 'postgres' | 'cockroachdb' | 'yugabytedb' | 'citus' | 'pglite'

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
  persistWarnings?: boolean;
  warningRetentionDays?: number;
  persistQueueStats?: boolean;
  queueStatRetentionDays?: number;
  bamIntervalSeconds?: number;
  flowIntervalSeconds?: number;
}

export interface QueueStats {
  name: string;
  deferredCount: number;
  queuedCount: number;
  readyCount: number;
  activeCount: number;
  failedCount: number;
  totalCount: number;
  capturedOn: Date;
}

export interface QueueStatsOptions {
  /** persistQueueStats on: only return snapshots captured at or after this time. */
  from?: Date;
  /** persistQueueStats on: only return snapshots captured at or before this time. */
  to?: Date;
  /** persistQueueStats on: maximum number of snapshots to return (1–100000, default 1000). */
  limit?: number;
  /**
   * persistQueueStats on: downsample the recorded series into fixed-width time buckets this many
   * seconds wide, returning one aggregated snapshot per bucket instead of raw rows. Each bucket
   * collapses its count columns via {@link aggregate}. Buckets align to the Unix epoch, so their
   * boundaries are deterministic and stable across calls. Must be a positive integer. Omitted →
   * raw snapshots (current behavior). Size it so the bucket count stays within `limit`, otherwise
   * only the newest `limit` buckets are returned and the oldest part of the window is dropped.
   */
  bucketSeconds?: number;
  /**
   * persistQueueStats on: auto-downsample. Derive {@link bucketSeconds} so the series fits in
   * roughly this many points — e.g. a chart's pixel width. Must be a positive integer. The window
   * spanned is `from`/`to` when supplied (so an explicit x-axis range yields stable buckets even
   * with sparse data), falling back to the data's own `min`/`max` captured timestamps for any
   * open side. Ignored when `bucketSeconds` is set (explicit resolution wins).
   */
  maxDataPoints?: number;
  /**
   * persistQueueStats on: how each count column is collapsed within a bucket when `bucketSeconds`
   * or `maxDataPoints` is set. `'max'` surfaces peak depth (best for backlog alerting), `'min'`
   * the trough, `'avg'` the rounded mean. Ignored when neither bucket option is set.
   * @default 'max'
   */
  aggregate?: 'max' | 'min' | 'avg';
  /**
   * persistQueueStats off: return a fresh reading. Recomputes the counts from the job table and
   * refreshes the queue-table cache rather than serving the regular (up to ~1h) cache, but still
   * reuses anything computed in the last minute so repeated forced calls don't each re-aggregate.
   */
  force?: boolean;
}

/**
 * Options for running pg-boss against a specific database backend.
 *
 * `backend` is the only knob — it expands to the correct internal compatibility flags
 * for that database (fetch strategy, mutation strategy, schema shape). Those flags are
 * derived from the backend and are not individually configurable, so a deployment can't
 * end up with an inconsistent combination.
 *
 * @see https://timgit.github.io/pg-boss/docs/database-backends#backend-profiles
 */
export interface BackendOptions {
  /**
   * Selects the database backend pg-boss is running against, expanding to the right
   * preset of internal compatibility flags. Databases without a profile (e.g. Aurora
   * DSQL, Spanner) are not yet supported.
   * @see BackendProfile
   * @default 'postgres'
   */
  backend?: BackendProfile;
}

/**
 * Internal compatibility flags derived from {@link BackendOptions.backend}. These are
 * resolved from the backend profile and are not part of the public constructor input —
 * read them off the resolved config, never set them directly.
 * @internal
 */
export interface CompatibilityFlags {
  /**
   * Fetch jobs with an atomic `UPDATE ... RETURNING` (plus a `state < 'active'` recheck)
   * instead of `SELECT FOR UPDATE SKIP LOCKED`, for engines where SKIP LOCKED performs
   * poorly or skips rows (e.g. CockroachDB).
   */
  noSkipLocked?: boolean;
  /**
   * Run `complete`, `fail`, and supervisor expiry as split statements inside a
   * transaction instead of one multi-mutation CTE, for engines that reject "multiple
   * mutations of the same table" in one statement (e.g. CockroachDB). (Coercing
   * text-encoded integers back to numbers is keyed on `backend === 'cockroachdb'`.)
   */
  noMultiMutationCte?: boolean;
  /** Create the job table without `PARTITION BY LIST` (also disables per-queue `partition: true`). */
  noTablePartitioning?: boolean;
  /** Omit `DEFERRABLE INITIALLY DEFERRED` on foreign keys. */
  noDeferrableConstraints?: boolean;
  /** Disable advisory locks (`pg_advisory_xact_lock`) used to coordinate schema creation and migrations. */
  noAdvisoryLocks?: boolean;
  /** Omit the `INCLUDE` clause on covering indexes. */
  noCoveringIndexes?: boolean;
  /**
   * Skip LISTEN/NOTIFY entirely, for engines that don't implement it (e.g. CockroachDB).
   * Suppresses both the producer-side transactional `pg_notify` (which would otherwise error
   * on insert) and the `useListenNotify` listener. Polling delivers jobs. (YugabyteDB does
   * support cluster-wide LISTEN/NOTIFY, so it does NOT set this flag.)
   */
  noListenNotify?: boolean;
}

export interface Migration {
  release: string
  version: number
  previous: number
  install: string[]
  async?: string[]
  uninstall?: string[]
}

export interface ConstructorOptions extends DatabaseOptions, SchedulingOptions, MaintenanceOptions, BackendOptions {
  /**
   * Enables the LISTEN/NOTIFY listener so workers on notify-enabled queues are woken
   * the moment a job is created, instead of waiting out their polling interval. This
   * holds one dedicated database connection for listening. Polling always remains active
   * as a correctness floor. Requires a pg-boss-owned pool (or an adapter that supports
   * `listen`) and a session-pinned connection — it will not work through PgBouncer in
   * transaction pooling mode. When it can't be established, pg-boss emits a `warning` and
   * continues polling only. Opt in per queue via the queue's `notify` option.
   * @default false
   */
  useListenNotify?: boolean;
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
  __test__throw_flow?: string;
  /** @internal */
  __test__bypass_flow_interval_check?: boolean;
  /** @internal */
  __test__force_cron_monitoring_error?: string;
  /** @internal */
  __test__force_clock_skew_warning?: string;
  /** @internal */
  __test__force_clock_monitoring_error?: string;
  /** @internal */
  __test__enableSpies?: boolean;
  /** @internal */
  __test__delay_maint_ms?: number;
  /** @internal */
  __test__delay_bam_ms?: number;
  /** @internal */
  __test__delay_flow_ms?: number;
  /** @internal */
  __test__delay_clock_skew_ms?: number;
  /**
   * Force the distributed runtime toggles (`noSkipLocked` + `noMultiMutationCte`) on top
   * of the current backend's schema, so the distributed code paths can be exercised on a
   * plain Postgres instance (see `npm run test:distributed`) without a distributed DB.
   * @internal
   */
  __test__distributed?: boolean;
  /**
   * Force `noAdvisoryLocks` on top of the current backend's schema, so the advisory-lock-free
   * SQL path (the same one YugabyteDB and CockroachDB take) can be exercised on a plain Postgres
   * instance without standing up one of those databases.
   * @internal
   */
  __test__noAdvisoryLocks?: boolean;
  /** @internal */
  migrations?: Migration[];
}

/** @internal */
export interface ResolvedConstructorOptions extends ConstructorOptions, CompatibilityFlags {
  schema: string;
  monitorIntervalSeconds: number;
  cronMonitorIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
  bamIntervalSeconds: number;
  flowIntervalSeconds: number;
}

/**
 * Options for a queue. All retry, expiration, and retention options set on a
 * queue will be inherited by each job in the queue unless they are overridden.
 */
export interface QueueOptions {
  /**
   * How many seconds a job may be in active state before being retried or
   * failed. Must be >=1. The default is 15 minutes.
   * @default 900
   */
  expireInSeconds?: number;
  /**
   * How many seconds a job may be in created or retry state before it's
   * deleted. Must be >=1. The default is 14 days.
   * @default 1209600
   */
  retentionSeconds?: number;
  /**
   * How long a job should be retained in the database after it's completed. Set
   * to `0` to never delete completed jobs. The default is 7 days.
   * @default 604800
   */
  deleteAfterSeconds?: number;
  /**
   * Number of times a job is allowed to be retried before it is marked as
   * failed.
   * @default 2
   */
  retryLimit?: number;
  /**
   * Delay between retries of failed jobs, in seconds.
   * @default 0
   */
  retryDelay?: number;
  /**
   * Enables exponential backoff retries based on `retryDelay` instead of a
   * fixed delay. Sets initial `retryDelay` to 1 if not set.
   *
   * A simplified function to get the delay between runs is: `retryDelay * 2 ^ retryCount`
   * with some jitter.
   *
   * The function used to determine the backoff delay is:
   * ```js
   * Math.min(retryDelayMax, retryDelay * (2 ** Math.Min(16, retryCount) / 2 + 2 Math.Min(16, retryCount) / 2 * Math.random()))
   * ```
   * @default false
   */
  retryBackoff?: boolean;
  /**
   * Maximum delay between retries of failed jobs, in seconds. Only used when
   * `retryBackoff` is `true`. The default is no limit.
   */
  retryDelayMax?: number;
  /**
   * Expected heartbeat interval in seconds. When set, workers must send periodic
   * heartbeats. If no heartbeat is received within this interval, the monitor will
   * fail/retry the job. Must be >= 10. NULL = heartbeat disabled (default).
   */
  heartbeatSeconds?: number;
}

export interface GroupOptions {
  id: string;
  tier?: string;
}

export interface DependencyRef {
  name: string;
  id: string;
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
  group?: GroupOptions;
  deadLetter?: string;
}

export interface FlowJob {
  ref: string;
  name: string;
  data?: object;
  options?: Omit<JobInsert, 'data'>;
  dependsOn?: string[];
}

export interface ConnectionOptions {
  db?: IDatabase;
}

export interface CompleteOptions extends ConnectionOptions {
  includeQueued?: boolean;
}

export interface FindJobsOptions extends ConnectionOptions {
  id?: string;
  key?: string;
  data?: object;
  queued?: boolean;
}

export interface RedriveOptions extends ConnectionOptions {
  /**
   * Override queue to move jobs into. Defaults to each job's original source
   * queue (`sourceName`). Jobs with no recorded source queue are only
   * moved when this is supplied.
   */
  destination?: string;
  /**
   * Only redrive jobs that originated from this source queue. Useful when a
   * single dead letter queue collects from multiple sources.
   */
  sourceName?: string;
  /**
   * Maximum number of jobs to move in this call, oldest first. Loop or schedule
   * repeated calls to drain at a controlled rate.
   * @default 1000
   */
  limit?: number;
}

export type InsertOptions = ConnectionOptions & { returnId?: boolean }

export type SendOptions = JobOptions & QueueOptions & ConnectionOptions

/**
 * When `update()`/`upsert()` targets jobs by `singletonKey` and more than one
 * pre-active (created or retry) job shares that key (possible under
 * throttle/debounce or a manually-set key on a `standard` queue), this selects
 * which match(es) to overwrite, ordered by `createdOn`:
 * - `newest` (default) overwrites the most recently enqueued match
 * - `oldest` overwrites the earliest enqueued match
 * - `all` overwrites every match
 */
export type JobMatchStrategy = 'newest' | 'oldest' | 'all'

/**
 * Options for `update()` and `upsert()`. Target a job with exactly one of `id`
 * or `singletonKey` (`upsert()` requires `singletonKey`). Only the fields you
 * supply are changed; any option you omit is left at the job's current value
 * (this is a partial edit, not a re-`send()`). `match` is only valid when
 * targeting by `singletonKey`.
 *
 * This is a curated subset of `SendOptions`: the throttle/debounce options
 * (`singletonSeconds`, `singletonNextSlot`) are intentionally excluded because
 * `update`/`upsert` do not act on them (a job's throttle slot is preserved).
 */
export type UpdateOptions =
  Pick<JobOptions, 'id' | 'priority' | 'startAfter' | 'singletonKey' | 'group' | 'deadLetter'>
  & QueueOptions
  & ConnectionOptions
  & { match?: JobMatchStrategy }

/**
 * The queue policy dictates how jobs are allowed to be queued and processed.
 *
 * - `standard` supports all standard features such as deferral, priority, and
 *   throttling.
 *
 * - `short` only allows 1 job to be queued, unlimited active. Can be extended
 *   with `singletonKey`.
 *
 * - `singleton` only allows 1 job to be active, unlimited queued. Can be
 *   extended with `singletonKey`.
 *
 * - `stately` offers a combination of `short` and `singleton`; only allows 1
 *   job per state, queued and/or active. Can be extended with `singletonKey`.
 *
 * - `exclusive` only allows 1 job to be queued or active. Can be extended with
 *   singletonKey`.
 *
 * - `key_strict_fifo` ensures strict FIFO ordering per `singletonKey`. Requires
 *   `singletonKey` on every job. Blocks processing of jobs with the same key
 *   while any job with that key is active, in retry, or failed.
 */
export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive' | 'key_strict_fifo' | (string & {})

export interface Queue extends QueueOptions {
  /**
   * The name of the queue.
   */
  name: string;
  /**
   * The policy for the queue.
   * @default 'standard'
   */
  policy?: QueuePolicy;
  /**
   * If set to true, a dedicated table will be created in the partition scheme.
   * This is more useful for a large queue in order to keep it from being a
   * "noisy neighbor".
   * @default false
   */
  partition?: boolean;
  /**
   * The name of the queue's dead letter queue. When a job fails after all
   * retries, the job's payload will be copied into said queue, copying the same
   * retention and retry configuration as the original job.
   */
  deadLetter?: string;
  /**
   * The number of jobs allowed to exist in the created or retry state before
   * emitting a warning event.
   */
  warningQueueSize?: number;
  /**
   * Expected heartbeat interval in seconds for jobs in this queue.
   * When set, workers must send periodic heartbeats. NULL = heartbeat disabled (default).
   */
  heartbeatSeconds?: number;
  /**
   * When `true`, creating a job on this queue emits a Postgres NOTIFY so workers wake
   * immediately rather than waiting for their next poll. Requires the instance-level
   * `useListenNotify` option to be enabled for the listener to act on it. Polling still
   * runs as a fallback.
   * @default false
   */
  notify?: boolean;
}

export interface QueueResult extends Queue {
  deferredCount: number;
  queuedCount: number;
  /**
   * Jobs ready to be processed now: `queuedCount - deferredCount` (clamped at 0). This is the
   * true backlog — `queuedCount` includes deferred (future-dated) jobs that are not yet runnable.
   */
  readyCount: number;
  activeCount: number;
  /**
   * Failed jobs still retained in the table. Bounded by the queue's retention/deletion policy,
   * so this is a rolling count of recent failures, not an all-time total.
   */
  failedCount: number;
  totalCount: number
  table: string;
  createdOn: Date;
  updatedOn: Date;
  singletonsActive: string[] | null;
}

export type ScheduleOptions = SendOptions & { tz?: string, key?: string }

/**
 * How long a worker waits between fetches. The delay before each fetch is chosen by
 * precedence — **burst → notify → base**:
 *
 * 1. **burst** (fetch continuously): a `burstWhen*` trigger is active and the last fetch
 *    came back full, so there is clearly more work to pull.
 * 2. **notify** (`notifyPollingIntervalSeconds`): NOTIFY is active for the queue, so polling
 *    is just a relaxed backstop.
 * 3. **base** (`pollingIntervalSeconds`): the normal idle poll.
 */
export interface JobPollingOptions {
  /**
   * Base interval to check for new jobs, in seconds. Must be >= `0.5` (500 ms).
   *
   * Used when no faster/slower mode applies: queues without `notify`, or notify-enabled
   * queues when the LISTEN/NOTIFY listener is unavailable (e.g. the adapter doesn't support
   * it or the connection dropped).
   * @default 2
   */
  pollingIntervalSeconds?: number;
  /**
   * Interval to check for new jobs, in seconds, used only while NOTIFY is active for the
   * queue — i.e. the queue has `notify: true` and the instance-level LISTEN/NOTIFY
   * listener is established. Since NOTIFY wakes workers immediately, polling only needs to
   * run as a slow backstop, so this can be much larger than `pollingIntervalSeconds`. When
   * notify is off or unavailable, `pollingIntervalSeconds` is used instead. Must be >= `0.5`.
   * @default 30
   */
  notifyPollingIntervalSeconds?: number;
  /**
   * Burst trigger. When the queue's cached `readyCount` (the runnable backlog) exceeds this
   * value, the worker fetches continuously with no delay until it catches up (a fetch that
   * comes back short ends burst mode). Takes precedence over `notifyPollingIntervalSeconds` and
   * `pollingIntervalSeconds`. Must be an integer >= 1.
   *
   * The ready count is read from the stats cache, so reaction latency is bounded by the
   * instance-level stats pipeline (`monitorIntervalSeconds` / `superviseIntervalSeconds` /
   * `queueCacheIntervalSeconds`, all default 60s).
   */
  burstWhenReadyExceeds?: number;
  /**
   * Burst trigger. While each fetch returns a full `batchSize` batch there is clearly more
   * work, so the worker keeps fetching continuously with no delay; the first short fetch ends
   * burst mode. Unlike `burstWhenReadyExceeds` this is instant and needs no cached
   * stats. Ignored when `batchSize` is 1 (every successful fetch would otherwise be "full").
   * @default false
   */
  burstWhenBatchFull?: boolean;
}

export interface JobFetchOptions {
  /**
   * If `true`, all job metadata will be included in the returned job object.
   * @default false
   */
  includeMetadata?: boolean;
  /**
   * Allow jobs with a higher priority to be fetched before jobs with lower or
   * no priority.
   * @default true
   */
  priority?: boolean;
  /**
   * Fetch jobs in the order they were created. Set to `false` to disable this
   * sorting and improve performance when the order of jobs does not matter.
   * @default true
   */
  orderByCreatedOn?: boolean;
  /**
   * The number of jobs to fetch.
   * @default 1
   */
  batchSize?: number;
  /**
   * Fetch jobs even if they have a `startAfter` timestamp in the future.
   * @default false
   */
  ignoreStartAfter?: boolean;
  /**
   * Only fetch jobs with a priority greater than or equal to this value.
   * Useful for reserving worker capacity exclusively for higher-priority jobs.
   * Must be an integer. If both `minPriority` and `maxPriority` are set,
   * `minPriority` must be less than or equal to `maxPriority`.
   */
  minPriority?: number;
  /**
   * Only fetch jobs with a priority less than or equal to this value.
   * Useful for workers dedicated to lower-priority background work.
   * Must be an integer. If both `minPriority` and `maxPriority` are set,
   * `minPriority` must be less than or equal to `maxPriority`.
   */
  maxPriority?: number;
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

export type WorkOptions = JobFetchOptions & JobPollingOptions & WorkConcurrencyOptions & {
  /**
   * Custom heartbeat refresh interval in seconds. Defaults to `heartbeatSeconds / 2`.
   * Must be strictly less than `heartbeatSeconds`.
   */
  heartbeatRefreshSeconds?: number;
  /**
   * Opt in to per-job settlement for batch handlers. When true, the handler must resolve with a
   * `JobResult[]` describing the outcome (`completed`, `failed`, or `deadletter`, with optional
   * per-job `output`) of each job in the batch. pg-boss settles each job individually, preserving
   * its own output. Any job omitted from the result is failed (and retried) with a descriptive
   * error. Throwing from the handler still fails the whole batch. Defaults to false.
   */
  perJobResults?: boolean;
}
export interface FetchGroupConcurrencyOptions {
  groupConcurrency?: number | GroupConcurrencyConfig;
  ignoreGroups?: string[] | null;
}

export type FetchOptions = JobFetchOptions & ConnectionOptions & FetchGroupConcurrencyOptions

export interface ResolvedWorkOptions extends WorkOptions {
  pollingInterval: number;
  notifyPollingInterval: number;
}

export interface WorkHandler<ReqData, ResData = any> {
  (job: Job<ReqData>[]): Promise<ResData>;
}

export interface WorkWithMetadataHandler<ReqData, ResData = any> {
  (job: JobWithMetadata<ReqData>[]): Promise<ResData>;
}

export type JobResultStatus = 'completed' | 'failed' | 'deadletter'

/**
 * Per-job outcome returned by a `perJobResults` batch handler. `id` must match a job from the
 * batch; `output` is stored on that job (the completion result, or the failure detail).
 *
 * `deadletter` fails the job terminally and routes it straight to the queue's configured dead
 * letter queue, bypassing any remaining retries. If the queue has no dead letter queue, it simply
 * fails terminally (same as a `failed` job whose retries are exhausted).
 */
export interface JobResult<ResData = any> {
  id: string;
  status: JobResultStatus;
  output?: ResData;
}

export interface PerJobWorkHandler<ReqData> {
  (job: Job<ReqData>[]): Promise<JobResult[]>;
}

export interface PerJobWorkWithMetadataHandler<ReqData> {
  (job: JobWithMetadata<ReqData>[]): Promise<JobResult[]>;
}

/**
 * Resolves the handler signature a `work` call must satisfy from the *inferred* options type `O`.
 * A literal `perJobResults: true` (optionally with `includeMetadata: true`) demands a per-job handler
 * that resolves with a `JobResult[]`; anything else keeps the permissive single-output handler.
 *
 * Because the branch is driven by `O extends { perJobResults: true }`, only a statically-known `true`
 * selects the strict handler. Options whose `perJobResults` is a plain `boolean` (e.g. a value typed
 * as `WorkOptions`, or `{ perJobResults: someFlag }`) do not match the literal and fall through to the
 * permissive handler, so dynamically-built options keep compiling exactly as before.
 */
export type WorkHandlerFor<O extends WorkOptions, ReqData, ResData = any> =
  O extends { perJobResults: true }
    ? (O extends { includeMetadata: true } ? PerJobWorkWithMetadataHandler<ReqData> : PerJobWorkHandler<ReqData>)
    : (O extends { includeMetadata: true } ? WorkWithMetadataHandler<ReqData, ResData> : WorkHandler<ReqData, ResData>)

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
  heartbeatSeconds: number | null;
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
  heartbeatOn: Date | null;
  heartbeatSeconds: number | null;
  blocked: boolean;
  blocking: boolean;
  pendingDependencies: number;
  deadLetter: string;
  output: object;
  /**
   * For a job that was moved into a dead letter queue, the name of the queue it
   * originally failed on. `null` for jobs that were not dead-lettered.
   */
  sourceName: string | null;
  /**
   * For a dead-lettered job, the id of the original job that failed. `null`
   * otherwise.
   */
  sourceId: string | null;
  /**
   * For a dead-lettered job, the `createdOn` of the original job, preserving its
   * true age in the system across the move. `null` otherwise.
   */
  sourceCreatedOn: Date | null;
  /**
   * For a dead-lettered job, the number of retries the original job consumed
   * before it was dead-lettered. `null` otherwise.
   */
  sourceRetryCount: number | null;
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
  heartbeatSeconds?: number;
  group?: GroupOptions;
  deadLetter?: string;
}

export type WorkerState = 'created' | 'active' | 'stopping' | 'stopped'

export interface WipData {
  id: string;
  workId: string;
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

export type WarningType = 'slow_query' | 'queue_backlog' | 'clock_skew'

export interface PersistedWarning {
  id: number;
  type: WarningType;
  message: string;
  data: object;
  createdOn: Date;
}

export interface CommandResponse {
  /** @internal */
  jobs: string[];
  /** @internal */
  requested: number;
  /** @internal */
  affected: number;
}

/**
 * The result of `update()` and `upsert()`. Unlike the target-a-list mutators
 * (`cancel`/`resume`/etc.), these discover how many jobs a target resolves to
 * and, for `upsert()`, whether a row was overwritten or newly created.
 */
export interface UpdateResponse {
  /** Ids of the jobs affected — overwritten in place, or newly inserted (`upsert` only). */
  jobs: string[];
  /** Number of existing jobs overwritten in place. */
  updated: number;
  /** Number of jobs newly inserted. Always `0` for `update()`. */
  inserted: number;
}

export interface BamEntry {
  id: string
  name: string
  version: number
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  queue?: string
  table: string
  command: string
  error?: string
  createdOn: Date
  startedOn?: Date
  completedOn?: Date
}

export interface BamStatusSummary {
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  count: number
  lastCreatedOn: Date
}

export interface FlowEvent {
  table: string
  resolved: number
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
  flow: [data: FlowEvent]
}
