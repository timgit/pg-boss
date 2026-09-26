import assert from 'node:assert'
import EventEmitter from 'node:events'
import * as Attorney from './attorney.ts'
import Contractor from './contractor.ts'
import Manager from './manager.ts'
import Timekeeper from './timekeeper.ts'
import Boss from './boss.ts'
import Bam from './bam.ts'
import Navigator from './navigator.ts'
import Notifier from './notifier.ts'
import { delay } from './tools.ts'
import { isAttachable } from './clock.ts'
import { trackActivity } from './activity.ts'
import type * as types from './types.ts'
import * as plans from './plans.ts'
import DbDefault from './db.ts'
import type { JobSpyInterface } from './spy.ts'

export { JOB_STATES as states } from './plans.ts'
export { QUEUE_POLICIES as policies } from './plans.ts'
export { SCHEDULE_KINDS as scheduleKinds } from './plans.ts'
export { SCHEDULE_MISSED_POLICIES as scheduleMissedPolicies } from './plans.ts'
export { PREVIEW_MAX_COUNT as previewScheduleMaxCount } from './timekeeper.ts'

export const events: types.Events = Object.freeze({
  error: 'error',
  warning: 'warning',
  wip: 'wip',
  stopped: 'stopped',
  bam: 'bam',
  flow: 'flow'
})

export function getConstructionPlans (schema?: string, options?: types.ConstructionPlanOptions) {
  return Contractor.constructionPlans(schema, options)
}

export function getMigrationPlans (schema?: string, version?: number, options?: types.MigrationPlanOptions) {
  return Contractor.migrationPlans(schema, version, options)
}

/**
 * The catalog query pg-boss uses to find bloated job indexes, as SQL text. Runnable in psql with no
 * pg-boss instance and no connection from this process. PostgreSQL only. The heap-less engines
 * (CockroachDB, YugabyteDB) do not answer it.
 */
export function getIndexBloatPlans (schema?: string, options?: types.IndexBloatOptions) {
  return plans.getBloatedIndexes(schema || plans.DEFAULT_SCHEMA, undefined, options)
}

export function getRollbackPlans (schema?: string, version?: number, options?: types.PlanOptions) {
  return Contractor.rollbackPlans(schema, version, options)
}

export class PgBoss extends EventEmitter<types.PgBossEventMap> {
  #stopped: boolean
  #started: boolean | undefined
  #startingPromise: Promise<this> | null = null
  #stoppingPromise: Promise<void> | null = null
  #attachedClock: AsyncDisposable | null = null
  #idle: (() => Promise<boolean>) | undefined
  #config: types.ResolvedConstructorOptions
  #db: (types.IDatabase & { _pgbdb?: false }) | DbDefault
  #boss: Boss
  #contractor: Contractor
  #manager: Manager
  #timekeeper: Timekeeper
  #bam: Bam
  #navigator: Navigator
  #notifier: Notifier

  constructor (connectionString: string)
  constructor (options: types.ConstructorOptions)
  constructor (value: string | types.ConstructorOptions) {
    super()
    this.#stopped = true

    const config = Attorney.getConfig(value)
    this.#config = config

    let db: (types.IDatabase & { _pgbdb?: false }) | DbDefault = this.getDb()

    // Before any component takes the db, so every statement they run is counted.
    if (isAttachable(config.clock)) {
      const tracked = trackActivity(db)
      db = tracked.db
      this.#idle = tracked.idle
    }

    this.#db = db

    if ('_pgbdb' in this.#db && this.#db._pgbdb) {
      this.#promoteEvents(this.#db)
    }

    const contractor = new Contractor(db, config)

    const manager = new Manager(db, config)

    const boss = new Boss(db, manager, config)

    const timekeeper = new Timekeeper(db, manager, config)
    manager.timekeeper = timekeeper

    const bam = new Bam(db, config)

    const navigator = new Navigator(db, manager, config)

    const notifier = new Notifier(db, manager, config)
    manager.notifier = notifier

    this.#promoteEvents(manager)
    this.#promoteEvents(boss)
    this.#promoteEvents(timekeeper)
    this.#promoteEvents(bam)
    this.#promoteEvents(navigator)
    this.#promoteEvents(notifier)

    this.#boss = boss
    this.#contractor = contractor
    this.#manager = manager
    this.#timekeeper = timekeeper
    this.#bam = bam
    this.#navigator = navigator
    this.#notifier = notifier
  }

  #promoteEvents (emitter: types.EventsMixin) {
    for (const event of Object.values(emitter?.events) as (keyof types.PgBossEventMap)[]) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  async start (): Promise<this> {
    // A stop() already in flight must finish (clearing any resources it's tearing down) before a
    // fresh start() begins, otherwise the two race over the same intervals/pool.
    if (this.#stoppingPromise) {
      await this.#stoppingPromise.catch(() => {})
    }

    // Return the SAME in-flight promise to a concurrent caller instead of a fresh `this`. A
    // second caller must observe the actual outcome (including a rejection), not silently no-op
    // while the first call is still mid-flight.
    if (this.#startingPromise) {
      return this.#startingPromise
    }

    if (this.#started) {
      return this
    }

    // Cleared to false before any subsystem is started (not just on success): if #doStart throws
    // partway through, subsystems already started (e.g. manager's queueCacheInterval/wipInterval)
    // must still be reachable by stop() for cleanup, and stop() no-ops whenever #stopped is true.
    this.#stopped = false

    this.#startingPromise = this.#doStart()

    try {
      return await this.#startingPromise
    } finally {
      this.#startingPromise = null
    }
  }

  async #doStart (): Promise<this> {
    // Before anything opens a connection or runs a statement. The schema clock is gated on a
    // session setting, and a session that misses it reads real time while its peers read fake
    // time - silently, and differently on every checkout. Declaring the setup here means no
    // connection the adapter opens for the contractor, or for any later work, can predate it.
    if (isAttachable(this.#config.clock)) {
      assert(typeof this.#db.setSessionStatements === 'function',
        'configuration assert: this db adapter does not implement setSessionStatements(), so a TestClock cannot reach every session it opens. Implement it to run the given statements on each new connection (or once, if the adapter has a single session).')

      await this.#db.setSessionStatements([plans.enableClockOverride()])
    }

    if (this.#db._pgbdb && !this.#db.opened) {
      await this.#db.open()
    }

    await this.#warnIfDistributedMisconfigured()

    if (this.#config.migrate) {
      await this.#contractor.start()
    } else {
      await this.#contractor.check()
    }

    if (isAttachable(this.#config.clock)) {
      this.#attachedClock = await this.#config.clock.attach({ db: this.#db, schema: this.#config.schema, idle: this.#idle })
    }

    await this.#manager.start()

    if (this.#config.useListenNotify) {
      await this.#notifier.start()
    }

    // Whether or not supervise is set, which only decides if their timers are armed
    await this.#boss.start()
    await this.#navigator.start()

    if (this.#config.schedule) {
      await this.#timekeeper.start()
    }

    if (this.#config.migrate) {
      await this.#bam.start()
    }

    this.#started = true

    return this
  }

  // YugabyteDB needs the yugabytedb backend profile (no table partitioning + no advisory locks;
  // partitioned queues are not supported there). pg-boss can't know the backend at construction
  // time, so detect it from the server version at startup and warn when the profile isn't selected.
  // Best-effort: never block startup on this check.
  async #warnIfDistributedMisconfigured (): Promise<void> {
    try {
      const { rows } = await this.#db.executeSql('SELECT version()')
      const version: string = rows?.[0]?.version || ''

      if (/yugabyte|-yb-/i.test(version)) {
        if (!this.#config.noTablePartitioning || !this.#config.noAdvisoryLocks) {
          this.emit(events.warning, {
            message: "YugabyteDB detected: set backend: 'yugabytedb' for compatibility. Partitioned queues (partition: true) are not supported on YugabyteDB.",
            data: { backend: 'yugabytedb' }
          })
        }
      }
    } catch {
      // version detection is best-effort and must never prevent startup
    }
  }

  async stop (options: types.StopOptions = {}): Promise<void> {
    // A start() already in flight must finish (or fail) before stop() evaluates state, otherwise
    // stop() reads #stopped mid-start and silently no-ops while start() keeps running.
    if (this.#startingPromise) {
      await this.#startingPromise.catch(() => {})
    }

    if (this.#stoppingPromise) {
      return this.#stoppingPromise
    }

    let { close = true, graceful = true, timeout = 30000 } = options

    // stop({ close: false }) marks the instance stopped while leaving the pool open, so a later
    // stop() that asks to close has to be answered before the guard below. Everything else was
    // already shut down by the first stop(). The close is published as #stoppingPromise so a
    // concurrent stop() or start() waits for the pool to drain instead of falling through.
    if (this.#stopped && close && this.#db._pgbdb && this.#db.opened) {
      this.#stoppingPromise = this.#closeDb()

      try {
        return await this.#stoppingPromise
      } finally {
        this.#stoppingPromise = null
      }
    }

    if (this.#stopped) {
      return
    }

    timeout = Math.max(timeout, 1000)

    this.#stoppingPromise = this.#doStop(close, graceful, timeout)

    try {
      return await this.#stoppingPromise
    } finally {
      this.#stoppingPromise = null
    }
  }

  async #doStop (close: boolean, graceful: boolean, timeout: number): Promise<void> {
    await this.#notifier.stop()
    await this.#manager.stop()
    await this.#timekeeper.stop()
    await this.#boss.stop()
    await this.#navigator.stop()
    await this.#bam.stop()

    const shutdown = async () => {
      await this.#manager.failWip()

      const attachment = this.#attachedClock
      this.#attachedClock = null

      try {
        if (attachment) {
          await attachment[Symbol.asyncDispose]()
        }
      } finally {
        // Stop stamping the opt-in on connections opened after this point. Harmless if it lingers
        // - dispose restores the plain function body, which never reads the setting - but an
        // instance restarted without a clock should not keep setting it. Undone on the same
        // condition #doStart declared it on, so a start() that threw before attach() and a dispose
        // that fails both still clear it.
        if (isAttachable(this.#config.clock)) {
          await this.#db.setSessionStatements?.([])
        }
      }

      if (close) {
        await this.#closeDb()
      }

      this.#stopped = true
      this.#started = false

      this.emit(events.stopped)
    }

    if (!graceful) {
      await shutdown()
      return
    }

    // Real time, not the configured clock: the deadline bounds shutdown I/O, and under a test
    // clock nothing would tick it while the test is blocked inside stop().
    const deadline = { reached: false }
    const deadlineTimer = setTimeout(() => { deadline.reached = true }, timeout)

    try {
      while (!deadline.reached && this.#manager.hasPendingCleanups()) {
        await delay(500)
      }
    } finally {
      clearTimeout(deadlineTimer)
    }

    await shutdown()
  }

  async #closeDb (): Promise<void> {
    if (!this.#db._pgbdb || !this.#db.opened) {
      return
    }

    await this.#db.close()

    // Give event loop time to process socket closes
    await delay(10)
  }

  send (request: types.Request): Promise<string | null>
  send (name: string, data?: object | null, options?: types.SendOptions): Promise<string | null>
  async send (...args: any[]): Promise<string | null> {
    return await this.#manager.send(...args as Parameters<Manager['send']>)
  }

  sendAfter (name: string, data: object | null, options: types.SendOptions | null, date: Date): Promise<string | null>
  sendAfter (name: string, data: object | null, options: types.SendOptions | null, dateString: string): Promise<string | null>
  sendAfter (name: string, data: object | null, options: types.SendOptions | null, seconds: number): Promise<string | null>
  async sendAfter (name: string, data: object | null, options: types.SendOptions | null, after: Date | string | number): Promise<string | null> {
    return this.#manager.sendAfter(name, data, options, after)
  }

  sendThrottled (name: string, data: object | null, options: types.SendOptions | null, seconds: number, key?: string): Promise<string | null> {
    return this.#manager.sendThrottled(name, data, options, seconds, key)
  }

  update (request: types.UpdateRequest): Promise<types.UpdateResponse>
  update (name: string, data: object | null | undefined, options?: types.UpdateOptions): Promise<types.UpdateResponse>
  update (...args: any[]): Promise<types.UpdateResponse> {
    return this.#manager.update(...args as Parameters<Manager['update']>)
  }

  upsert (request: types.UpdateRequest): Promise<types.UpsertResponse>
  upsert (name: string, data: object | null | undefined, options?: types.UpdateOptions): Promise<types.UpsertResponse>
  upsert (...args: any[]): Promise<types.UpsertResponse> {
    return this.#manager.upsert(...args as Parameters<Manager['upsert']>)
  }

  sendDebounced (name: string, data: object | null, options: types.SendOptions | null, seconds: number, key?: string): Promise<string | null> {
    return this.#manager.sendDebounced(name, data, options, seconds, key)
  }

  insert (name: string, jobs: types.JobInsert[], options?: types.InsertOptions): Promise<string[] | null> {
    return this.#manager.insert(name, jobs, options)
  }

  flow (jobs: types.FlowJob[], options?: types.ConnectionOptions): Promise<Record<string, string>> {
    return this.#manager.flow(jobs, options)
  }

  fetch<T>(name: string, options: types.FetchOptions & { includeMetadata: true }): Promise<types.JobWithMetadata<T>[]>
  fetch<T>(name: string, options?: types.FetchOptions): Promise<types.Job<T>[]>
  fetch<T>(name: string, options: types.FetchOptions = {}): Promise<types.Job<T>[] | types.JobWithMetadata<T>[]> {
    return this.#manager.fetch<T>(name, options)
  }

  work<ReqData, ResData = any>(name: string, handler: types.WorkHandler<ReqData, ResData>): Promise<string>
  work<ReqData, ResData = any, const O extends types.WorkOptions = types.WorkOptions>(name: string, options: O, handler: types.WorkHandlerFor<O, ReqData, ResData>): Promise<string>
  work (...args: any[]): Promise<string> {
    return this.#manager.work(...args as Parameters<Manager['work']>)
  }

  offWork (name: string, options?: types.OffWorkOptions): Promise<void> {
    return this.#manager.offWork(name, options)
  }

  notifyWorker (workerId: string): void {
    return this.#manager.notifyWorker(workerId)
  }

  subscribe (event: string, name: string): Promise<void> {
    return this.#manager.subscribe(event, name)
  }

  unsubscribe (event: string, name: string): Promise<void> {
    return this.#manager.unsubscribe(event, name)
  }

  publish (event: string, data?: object, options?: types.SendOptions): Promise<void> {
    return this.#manager.publish(event, data, options)
  }

  cancel (name: string, id: string | string[] | types.JobAttempt | types.JobAttempt[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.cancel(name, id, options)
  }

  resume (name: string, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.resume(name, id, options)
  }

  retry (name: string, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.retry(name, id, options)
  }

  deleteJob (name: string, id: string | string[] | types.JobAttempt | types.JobAttempt[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.deleteJob(name, id, options)
  }

  redrive (name: string, options?: types.RedriveOptions): Promise<number> {
    return this.#manager.redrive(name, options)
  }

  previewRedrive (name: string, options?: types.RedriveFilter): Promise<types.RedrivePreview> {
    return this.#manager.previewRedrive(name, options)
  }

  deleteQueuedJobs (name: string): Promise<void> {
    return this.#manager.deleteQueuedJobs(name)
  }

  deleteStoredJobs (name: string): Promise<void> {
    return this.#manager.deleteStoredJobs(name)
  }

  deleteAllJobs (name?: string): Promise<void> {
    return this.#manager.deleteAllJobs(name)
  }

  complete (name: string, id: string | string[] | types.JobAttempt | types.JobAttempt[], data?: object | null, options?: types.CompleteOptions): Promise<types.CommandResponse> {
    return this.#manager.complete(name, id, data, options)
  }

  fail (name: string, id: string | string[] | types.JobAttempt | types.JobAttempt[], data?: object | null, options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.fail(name, id, data, options)
  }

  touch (name: string, id: string | string[] | types.JobAttempt | types.JobAttempt[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.touch(name, id, options)
  }

  /**
   * @deprecated Use findJobs() instead
   */
  getJobById<T>(name: string, id: string, options?: types.ConnectionOptions): Promise<types.JobWithMetadata<T> | null> {
    return this.#manager.getJobById<T>(name, id, options)
  }

  findJobs<T>(name: string, options?: types.FindJobsOptions): Promise<types.JobWithMetadata<T>[]> {
    return this.#manager.findJobs<T>(name, options)
  }

  createQueue (name: string, options?: Omit<types.Queue, 'name'>): Promise<void> {
    return this.#manager.createQueue(name, options)
  }

  getBlockedKeys (name: string): Promise<string[]> {
    return this.#manager.getBlockedKeys(name)
  }

  getDependencies (name: string, id: string, options?: types.ConnectionOptions): Promise<types.DependencyRef[]> {
    return this.#manager.getDependencies(name, id, options)
  }

  getDependents (name: string, id: string, options?: types.ConnectionOptions): Promise<types.DependencyRef[]> {
    return this.#manager.getDependents(name, id, options)
  }

  updateQueue (name: string, options?: types.UpdateQueueOptions): Promise<void> {
    return this.#manager.updateQueue(name, options)
  }

  deleteQueue (name: string): Promise<void> {
    return this.#manager.deleteQueue(name)
  }

  getQueues (names?: string[]): Promise<types.QueueResult[]> {
    return this.#manager.getQueues(names)
  }

  getQueue (name: string): Promise<types.QueueResult | null> {
    return this.#manager.getQueue(name)
  }

  getQueueStats (name: string, options?: types.QueueStatsOptions): Promise<types.QueueStats[]> {
    return this.#manager.getQueueStats(name, options)
  }

  isMaintaining (): boolean {
    return this.#boss.maintaining
  }

  isBamWorking (): boolean {
    return this.#bam.working
  }

  isResolvingFlow (): boolean {
    return this.#navigator.working
  }

  isCheckingSkew (): boolean {
    return this.#timekeeper.checkingSkew
  }

  isTimekeeping (): boolean {
    return this.#timekeeper.timekeeping
  }

  supervise (name?: string, options?: types.SuperviseOptions): Promise<void> {
    return this.#boss.supervise(name, options)
  }

  /**
   * The `REINDEX INDEX CONCURRENTLY` statements needed to rebuild the currently bloated job
   * indexes, in the order they should be run, including any `DROP INDEX CONCURRENTLY` for stubs
   * left by an interrupted rebuild.
   *
   * For installations where pg-boss cannot run them itself. A role that doesn't own the indexes,
   * or an adapter that wraps queries in a transaction. Pass `{ force: true }` for every job index
   * rather than only the bloated ones. Empty on CockroachDB and YugabyteDB, which have no btree
   * bloat to reclaim and reject `REINDEX` in any form.
   */
  getReindexCommands (options?: types.ReindexOptions): Promise<string[]> {
    return this.#boss.getReindexCommands(options)
  }

  // Force an immediate flow-resolution pass (unblock dependents of completed jobs) instead of
  // waiting for the next background poll. Mirrors supervise() for on-demand maintenance.
  resolveFlow (): Promise<void> {
    return this.#navigator.resolveNow()
  }

  getWipData (options?: { includeInternal?: boolean }): types.WipData[] {
    return this.#manager.getWipData(options)
  }

  getSpy<T = object> (name: string): JobSpyInterface<T> {
    return this.#manager.getSpy<T>(name)
  }

  clearSpies (): void {
    this.#manager.clearSpies()
  }

  isInstalled (): Promise<boolean> {
    return this.#contractor.isInstalled()
  }

  schemaVersion (): Promise<number | null> {
    return this.#contractor.schemaVersion()
  }

  detectSchemaDrift (): Promise<types.SchemaDriftReport> {
    return this.#contractor.detectDrift({ clockOverride: this.#attachedClock !== null })
  }

  /**
   * Schedules a job on a recurring expression: a cron expression, or an RFC 5545 recurrence rule
   * such as `FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17`.
   */
  schedule (name: string, cron: string, data?: object | null, options?: types.ScheduleOptions): Promise<void> {
    return this.#timekeeper.schedule(name, cron, data, options)
  }

  unschedule (name: string, key?: string): Promise<void> {
    return this.#timekeeper.unschedule(name, key)
  }

  getSchedules (name?: string, key?: string): Promise<types.Schedule[]> {
    return this.#timekeeper.getSchedules(name, key)
  }

  getSchedule (name: string, key?: string): Promise<types.Schedule | null> {
    return this.#timekeeper.getSchedule(name, key)
  }

  previewSchedule (cron: string, options?: types.PreviewScheduleOptions): Date[] {
    return this.#timekeeper.previewSchedule(cron, options)
  }

  async getBamStatus (): Promise<types.BamStatusSummary[]> {
    const sql = plans.getBamStatus(this.#config.schema)
    const { rows } = await this.#db.executeSql(sql)
    return rows
  }

  async getBamEntries (): Promise<types.BamEntry[]> {
    const sql = plans.getBamEntries(this.#config.schema)
    const { rows } = await this.#db.executeSql(sql)
    return rows
  }

  getDb (): types.IDatabase {
    if (this.#db) {
      return this.#db
    }

    if (this.#config.db) {
      return this.#config.db
    }

    return new DbDefault(this.#config)
  }
}

export { systemClock, TestClock } from './clock.ts'
export { CLOCK_OVERRIDE_SETTING, enableClockOverride, disableClockOverride } from './plans.ts'

export type {
  BackendProfile,
  BackendOptions,
  AttachableClock,
  Clock,
  ClockTimer,
  BamEntry,
  BamEvent,
  BamStatusSummary,
  CommandResponse,
  CompleteOptions,
  ConnectionOptions,
  ConstructorOptions,
  DatabaseOptions,
  FetchGroupConcurrencyOptions,
  DependencyRef,
  FetchOptions,
  FindJobsOptions,
  FlowJob,
  GroupConcurrencyConfig,
  GroupOptions,
  IDatabase as Db,
  InsertOptions,
  IndexBloat,
  IndexBloatOptions,
  InvalidIndex,
  Job,
  JobAttempt,
  JobFetchOptions,
  JobInsert,
  JobMatchStrategy,
  JobOptions,
  JobPollingOptions,
  JobResult,
  JobResultStatus,
  JobStates,
  Events,
  JobWithMetadata,
  MaintenanceOptions,
  ManagedIndex,
  MigrationPartition,
  AsyncMigrationCommand,
  MismatchedIndex,
  ManagedFunction,
  MismatchedFunction,
  TableColumnDrift,
  ConstraintDrift,
  EnumDrift,
  OffWorkOptions,
  PgBossEventMap,
  PreviewScheduleOptions,
  Queue,
  QueueOptions,
  QueuePolicy,
  QueueResult,
  QueueStats,
  QueueStatsOptions,
  RedriveFilter,
  RedriveOptions,
  RedrivePreview,
  ReindexOptions,
  Request,
  Schedule,
  ScheduleKind,
  ScheduleOptions,
  SchedulingOptions,
  SchemaDriftReport,
  SendOptions,
  StopOptions,
  SuperviseOptions,
  UpdateOptions,
  UpdateQueueOptions,
  UpdateRequest,
  UpdateResponse,
  UpsertResponse,
  Warning,
  WipData,
  WorkConcurrencyOptions,
  WorkerState,
  WorkHandler,
  WorkOptions,
  WorkWithMetadataHandler,
  WorkHandlerFor,
  PerJobWorkHandler,
  PerJobWorkWithMetadataHandler,
} from './types.ts'

export type {
  JobSpyInterface,
  JobSpyState,
  JobDataSelector,
  JobSelector,
  SpyJob,
} from './spy.ts'

export {
  fromKnex,
  fromKysely,
  fromDrizzle,
  fromPrisma,
  fromPglite,
  fromBunSql,
} from './adapters/index.ts'

export type {
  KnexTransactionLike,
  KyselyTransactionLike,
  DrizzleTransactionLike,
  DrizzleSqlTagLike,
  PrismaTransactionLike,
  PGliteLike,
  BunSqlLike,
  BunReservedSqlLike,
} from './adapters/index.ts'
