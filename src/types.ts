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
  /**
   * Interval in milliseconds between LISTEN/NOTIFY heartbeat checks on the dedicated
   * listener connection. Lower values detect silent connection drops faster at the cost
   * of more heartbeat queries. Defaults to 10000.
   */
  notifyHeartbeatIntervalMs?: number;
  /**
   * Timeout in milliseconds for each LISTEN/NOTIFY heartbeat query. If a heartbeat does
   * not complete within this window the listener is torn down and reconnected. Raise this
   * on a loaded database where the default is too aggressive. Defaults to 5000.
   */
  notifyHeartbeatTimeoutMs?: number;
  /**
   * TCP keepalive initial delay in milliseconds for the dedicated LISTEN/NOTIFY connection.
   * Defaults to 10000.
   */
  notifyKeepAliveInitialDelayMs?: number;
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
 * supported. @see https://pgboss.io/database-backends
 */
export type BackendProfile = 'postgres' | 'cockroachdb' | 'yugabytedb' | 'citus' | 'pglite'

export interface MaintenanceOptions {
  supervise?: boolean;
  migrate?: boolean;
  createSchema?: boolean;
  /**
   * Skips the startup check that refuses to install into `schema` when another schema differing
   * from it only by case already holds a pg-boss installation.
   *
   * That check exists because `schema: 'MySchema'` and `schema: '"MySchema"'` name two different
   * schemas — PostgreSQL folds the unquoted form to `myschema` and stores the quoted one verbatim —
   * so mis-spelling the quoting installs an empty second schema and every existing job appears to
   * vanish. Set this only if you genuinely intend two installations whose names differ by case.
   * @default false
   */
  allowSchemaCaseVariant?: boolean;
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
  /**
   * Rebuild bloated job indexes with `REINDEX INDEX CONCURRENTLY` during maintenance.
   *
   * Autovacuum reclaims heap space but never shrinks a btree, so a job index stays at the size of
   * the largest backlog its queue has ever held. Every later vacuum then walks all of those pages,
   * which is the dominant cost on a drained queue. Rebuilds are gated on a density check, so a
   * healthy installation never runs one.
   *
   * Set `false` to disable rebuilds entirely. Bloat detection and the `index_bloat` warning are
   * unaffected — use `getReindexCommands()` to run the statements yourself.
   * @default true
   */
  reindex?: boolean | ReindexOptions;
  /**
   * How often the bloat check runs. One instance per interval performs it, coordinated through
   * `version.reindex_on`. Must be >=1 second and cannot exceed 24 hours.
   * @default 86400
   */
  reindexIntervalSeconds?: number;
}

/** Thresholds for the index-bloat density check. */
export interface IndexBloatOptions {
  /**
   * Ignore indexes smaller than this many 8 kB pages.
   * @default 128
   */
  minPages?: number;
  /**
   * Live index entries per 8 kB page below which an index is considered bloated.
   * @default 5
   */
  maxEntriesPerPage?: number;
  /**
   * How many times larger than its live entries need an index must be before it counts as bloated.
   * The size those entries need is estimated from `pg_stats`, so a legitimately sparse index — a
   * long `singletonKey` packs fewer than five entries per page while perfectly packed — is not
   * mistaken for a bloated one.
   * @default 4
   */
  minSizeRatio?: number;
}

export interface ReindexOptions extends IndexBloatOptions {
  /**
   * Rebuild every job index in scope instead of only the bloated ones, and ignore the interval
   * claim so the pass runs immediately.
   * @default false
   */
  force?: boolean;
  /**
   * Never rebuild an index larger than this many bytes. A large index that still passes the density
   * gate carries a genuinely expensive rebuild, so it is left to an operator.
   * @default 2147483648
   */
  maxIndexBytes?: number;
}

export interface SuperviseOptions {
  /**
   * Overrides the constructor's `reindex` setting for this pass only.
   */
  reindex?: boolean | ReindexOptions;
}

/** A bloated index found by the maintenance density check. */
export interface IndexBloat {
  /** Index name, unqualified. */
  name: string;
  /** The job table the index belongs to. */
  table: string;
  /** Index size in 8 kB pages. */
  pages: number;
  /** Live index entries, as of the last VACUUM/ANALYZE. */
  entries: number;
  /** Index size on disk. */
  bytes: number;
  /** Whether the connected role can `REINDEX` it. */
  owned: boolean;
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
 * @see https://pgboss.io/database-backends#backend-profiles
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
  /**
   * The engine lacks (or doesn't populate) `pg_stat_progress_create_index`, so BAM can't tell
   * whether a stuck `in_progress` index build is still running. Set for CockroachDB/YugabyteDB,
   * whose online-DDL job model isn't the PG `CONCURRENTLY` path. When set, BAM reclaims stale
   * commands on the timeout alone and skips drop-then-rebuild healing.
   */
  noIndexProgressView?: boolean;
  /**
   * The engine stores data outside PostgreSQL's heap, so there is no btree page bloat to reclaim
   * and no `REINDEX` in any form — the `CONCURRENTLY` modifier is irrelevant, both engines reject
   * the plain statement too. Skips the index-bloat maintenance pass entirely, detection included.
   * Set for CockroachDB/YugabyteDB, where the check is not merely useless but unusable: CockroachDB
   * has no `pg_relation_size()` and rejects `reltuples / relpages`, while YugabyteDB reports both
   * `relpages` and `pg_relation_size()` as 0 for every relation.
   */
  noReindex?: boolean;
}

export interface Migration {
  release: string
  version: number
  previous: number
  install: string[]
  async?: Array<string | AsyncMigrationCommand>
  uninstall?: string[]
}

export interface AsyncMigrationCommand {
  name: string
  command: string
  partitionPolicy?: QueuePolicy
}

export interface MigrationPartition {
  tableName: string
  policy: QueuePolicy
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
  /**
   * Enables job spies for deterministic testing (see `getSpy`). Adds per-transition
   * tracking overhead — **NOT for production.**
   * @default false
   */
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
  /**
   * Force `noIndexProgressView` on top of the current backend, so the timeout-only BAM reclaim path
   * (no liveness, no CONCURRENTLY healing — the one CockroachDB/YugabyteDB take) can be exercised on
   * a plain Postgres instance.
   * @internal
   */
  __test__noIndexProgressView?: boolean;
  /**
   * Force `noReindex` on top of the current backend, so the skipped index-bloat pass
   * (used by CockroachDB/YugabyteDB) can be exercised on plain Postgres.
   * @internal
   */
  __test__noReindex?: boolean;
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
  reindexIntervalSeconds: number;
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

export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'

/** Columns `findJobs()` can sort and page on. Both are immutable for the life of a job. */
export type FindJobsOrderBy = 'createdOn' | 'startAfter'

export interface FindJobsOptions extends ConnectionOptions {
  id?: string;
  key?: string;
  data?: object;
  /**
   * Only return jobs in queued state (`created` or `retry`).
   *
   * Mutually exclusive with `states`, which expresses the same filter and more.
   */
  queued?: boolean;
  /**
   * Only return jobs in one of these states. Mutually exclusive with `queued`.
   */
  states?: JobState[];
  /**
   * Maximum number of jobs to return. Without it the result is unbounded, so a busy queue or a
   * long-lived singleton key returns its whole retained history.
   *
   * Supplying it turns ordering on, defaulting to `createdOn` ascending.
   */
  limit?: number;
  /**
   * Column to sort by. Supplying it turns ordering on.
   * @default 'createdOn' when any of `limit`, `cursor`, or `direction` is supplied, otherwise unordered
   */
  orderBy?: FindJobsOrderBy;
  /**
   * Sort direction. Supplying it turns ordering on.
   * @default 'asc'
   */
  direction?: 'asc' | 'desc';
  /**
   * Id of the last job from the previous page. The next page starts strictly after it in the
   * current ordering, so rows inserted or deleted between calls cannot shift the window.
   *
   * Supplying it turns ordering on. An id that does not name a job in this queue returns no rows.
   */
  cursor?: string;
}

export interface GetJobByKeyOptions extends ConnectionOptions {
  /**
   * Only consider jobs in queued state (`created` or `retry`).
   * @default false
   */
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
 * The object form accepted by the single-argument overload of `update()` and
 * `upsert()`, mirroring {@link Request} for `send()`. `data` is optional
 * (omit or pass `undefined` to edit only options; pass `null` to clear the
 * payload) and `options` carries the target (`id` or `singletonKey`).
 */
export interface UpdateRequest {
  name: string;
  data?: object | null;
  options?: UpdateOptions;
}

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
 * - `key_strict_fifo` ensures FIFO ordering per `singletonKey`. Requires
 *   `singletonKey` on every job. A job that is active, in retry, or failed only
 *   holds back successors with the same key; other keys remain fetchable.
 *   Priority cannot reorder jobs within a key. A job that is not yet fetchable
 *   is skipped when choosing a key's head, so deferred jobs join the ordering
 *   when their `startAfter` is reached, and flow-blocked jobs when their
 *   dependencies complete.
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
  state: JobState;
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

export type UpdateQueueOptions = Omit<Queue, 'name' | 'partition' | 'policy' | 'deadLetter' | 'retryDelayMax' | 'heartbeatSeconds'> & {
  /**
   * The name of the queue's dead letter queue, or `null` to clear it.
   */
  deadLetter?: string | null;
  /**
   * Maximum delay between retries of failed jobs, in seconds, or `null` for no limit.
   */
  retryDelayMax?: number | null;
  /**
   * Expected heartbeat interval in seconds, or `null` to disable heartbeats.
   */
  heartbeatSeconds?: number | null;
}

export interface Warning { message: string, data: object }

export type WarningType = 'slow_query' | 'queue_backlog' | 'clock_skew' | 'listen_notify_unavailable' | 'invalid_schedule' | 'index_bloat'

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
 * The result of `update()`. Unlike the target-a-list mutators
 * (`cancel`/`resume`/etc.), `update()` discovers how many jobs a target
 * resolves to. `update()` never inserts, so there is no `inserted` count —
 * see {@link UpsertResponse} for `upsert()`.
 */
export interface UpdateResponse {
  /** Ids of the jobs updated in place. */
  jobs: string[];
  /** Number of existing jobs updated in place (equals `jobs.length`). */
  updated: number;
}

/**
 * The result of `upsert()`. Extends {@link UpdateResponse} with the
 * update-vs-insert discriminator: a single `upsert()` either edits the
 * matching job(s) in place (`updated`) or inserts one new job (`inserted`),
 * so exactly one of the two counts is non-zero.
 */
export interface UpsertResponse extends UpdateResponse {
  /** Number of jobs newly inserted (mutually exclusive with `updated`). */
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
  // True when getNextBamCommand re-picked a command that was already attempted — a stale in_progress
  // row (prior claimer died mid-run) or a prior 'failed' row (including ones left by older releases) —
  // signalling that healing (drop-then-rebuild) may be needed. Only set on the liveness path.
  reattempt?: boolean
}

export interface BamStatusSummary {
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  count: number
  lastCreatedOn: Date
}

/** One managed index pg-boss expects to exist, and the table it belongs to. */
export interface ManagedIndex {
  name: string
  table: string
  /** Readable expected key-column list (ordered), for definition-diff. Absent if not derivable. */
  keys?: string
  /** Readable expected INCLUDE payload column list, '' for an index with no INCLUDE clause. */
  include?: string
  /** Readable expected partial-index predicate (the WHERE clause), '' for a non-partial index. */
  predicate?: string
  /** The full expected `CREATE INDEX` statement (schema-qualified), ready to run to recreate it. */
  definition?: string
}

/**
 * A managed index that is present in the catalog but marked INVALID. Its definition is correct (an
 * interrupted build, not a wrong shape), so only the expected `definition` is carried — there is no
 * meaningful actual-vs-expected diff to show.
 */
export interface InvalidIndex extends ManagedIndex {
  /** True when a pending/in_progress/failed BAM row is (re)building it, so it may heal itself. */
  building: boolean
}

/** A present index whose key columns/order or predicate differ from what the code expects. */
export interface MismatchedIndex extends ManagedIndex {
  /** Readable key-column list the code expects. */
  expectedKeys: string
  /** Readable key-column list actually in the catalog (from pg_get_indexdef). */
  actualKeys: string
  /** Readable INCLUDE payload list the code expects ('' when it expects no INCLUDE clause). */
  expectedInclude: string
  /** Readable INCLUDE payload list actually in the catalog ('' when the live index has none). */
  actualInclude: string
  /** Readable predicate the code expects ('' for a non-partial index). */
  expectedPredicate: string
  /** Readable predicate actually in the catalog, from pg_get_indexdef ('' for a non-partial index). */
  actualPredicate: string
  /** The index's current definition from pg_get_indexdef, for side-by-side comparison with `definition`. */
  actualDefinition: string
  /** Which parts differ — any of 'keys', 'include', 'predicate'. */
  differs: Array<'keys' | 'include' | 'predicate'>
}

/** One managed plpgsql/sql function pg-boss expects to exist, with its normalised body for diffing. */
export interface ManagedFunction {
  name: string
  /** Whitespace-normalised expected function body (the text between the outer `$$` dollar quotes). */
  expectedBody: string
  /** The full expected `CREATE FUNCTION` statement (schema-qualified), ready to run to recreate it. */
  definition: string
}

/** A present managed function whose body differs from what the code expects. */
export interface MismatchedFunction extends ManagedFunction {
  /** Whitespace-normalised body actually stored in the catalog (from pg_get_functiondef). */
  actualBody: string
  /** The function's current definition from pg_get_functiondef, for side-by-side comparison. */
  actualDefinition: string
}

/** Column drift for a managed table: columns the code expects that are absent, columns present in the
 *  catalog that the code does not expect, and (fixed tables only) columns whose default, data type, or
 *  nullability differs from the code's DDL. */
export interface TableColumnDrift {
  /** The (unqualified) table name. */
  table: string
  /** Expected columns with no matching catalog column. */
  missingColumns: string[]
  /** Catalog columns the expected set does not account for. */
  unexpectedColumns: string[]
  /** Columns whose live default expression differs from the code's expected default (fixed tables only). */
  defaultMismatches: Array<{ column: string, expected: string, actual: string }>
  /** Columns whose live data type differs from the code's expected type (fixed tables only). */
  typeMismatches: Array<{ column: string, expected: string, actual: string }>
  /** Columns whose live NOT NULL flag differs from the code's expectation (fixed tables only). */
  nullabilityMismatches: Array<{ column: string, expected: boolean, actual: boolean }>
}

/** Constraint-set drift for a managed table: expected constraints absent from the catalog, and catalog
 *  constraints the code does not expect. Compared on normalised pg_get_constraintdef strings. */
export interface ConstraintDrift {
  /** The (unqualified) table name. */
  table: string
  /** Expected constraints with no matching catalog constraint. */
  missingConstraints: string[]
  /** Catalog constraint definitions the expected set does not account for. */
  unexpectedConstraints: string[]
}

/** Drift in an enum type's value set or ordering (pg-boss's `job_state`). */
export interface EnumDrift {
  /** The enum type's name (e.g. `job_state`). */
  name: string
  /** Ordered enum labels the code expects. */
  expectedValues: string[]
  /** Ordered enum labels actually in the catalog. */
  actualValues: string[]
}

/**
 * Result of a schema drift scan: managed indexes, functions, and enums that should exist per the
 * code's expected shape vs. what the live catalog actually holds. Covers presence (missing / invalid
 * / unexpected) and definition-level drift (a present index, function body, or enum whose shape
 * differs from what the code emits).
 */
export interface SchemaDriftReport {
  /** True when nothing is missing, invalid, mismatched, or drifted (tables, columns, defaults, types,
   *  constraints, enum). `extraIndexes` is informational and does NOT affect this. */
  ok: boolean
  /** Expected managed tables with no matching catalog table. */
  missingTables: string[]
  /** Expected indexes with no matching catalog entry (excludes ones a BAM row is still building). */
  missing: ManagedIndex[]
  /** Expected indexes still being built by a pending/in_progress/failed BAM row — not yet drift. */
  building: ManagedIndex[]
  /** Present indexes marked INVALID (interrupted CREATE INDEX CONCURRENTLY). */
  invalid: InvalidIndex[]
  /**
   * Standalone (non-constraint-backing) indexes present on a managed table that the expected set does
   * not account for — a stale pg-boss index or one a user added. Informational only: an extra index is
   * harmless, so this is surfaced as a warning and does not make the schema "not ok".
   */
  extraIndexes: Array<{ name: string, table: string }>
  /** Present indexes whose key columns/order differ from the expected definition. */
  mismatched: MismatchedIndex[]
  /** Expected functions with no matching catalog entry. */
  missingFunctions: ManagedFunction[]
  /** Present functions whose body differs from the code's expected definition. */
  mismatchedFunctions: MismatchedFunction[]
  /** Managed tables with missing/unexpected columns or column-default drift (only differing tables). */
  columnDrift: TableColumnDrift[]
  /** Managed tables with missing or unexpected constraints (only tables that differ are listed). */
  constraintDrift: ConstraintDrift[]
  /** Enum drift when the live `job_state` value set/order differs from the code; null when it matches. */
  enumDrift: EnumDrift | null
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
