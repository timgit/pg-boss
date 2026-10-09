import assert, { AssertionError } from 'node:assert'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import * as Attorney from './attorney.ts'
import Contractor from './contractor.ts'
import Manager from './manager.ts'
import Timekeeper from './timekeeper.ts'
import Boss from './boss.ts'
import Bam from './bam.ts'
import Navigator from './navigator.ts'
import Notifier from './notifier.ts'
import Registrar from './registrar.ts'
import { delay, type AbortablePromise } from './tools.ts'
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
export { addBins, percentile } from './latency.ts'

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

/**
 * The SQL that removes every object pg-boss installs, for a schema it shares with other objects. A
 * schema of pg-boss's own is simpler to drop whole.
 * @see https://pgboss.io/api/utils#getuninstallplans-schema-options
 */
export function getUninstallPlans (schema?: string, options?: types.PlanOptions) {
  return Contractor.uninstallPlans(schema, options)
}

// start({ attempts }) waits 1 second after the first failure and doubles the wait up to this.
const START_RETRY_MAX_SECONDS = 30

export class PgBoss extends EventEmitter<types.PgBossEventMap> {
  #stopped: boolean
  #started: boolean | undefined
  #startingPromise: Promise<this> | null = null
  // The wait between start() attempts, so stop() can end it rather than sit out every retry.
  #startRetry: { cancelled: boolean, wait: AbortablePromise<void> | null } | null = null
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
  #registrar: Registrar

  constructor (connectionString: string)
  constructor (options: types.ConstructorOptions)
  constructor (value: string | types.ConstructorOptions) {
    super()
    this.#stopped = true

    const config = Attorney.getConfig(value)
    this.#config = config

    // Made here rather than at start(), since the pool is configured before it opens. Naming the
    // connections after the instance is what lets pg_stat_activity join to its registry row. Only
    // on a pool pg-boss creates, and never over a name the caller chose.
    const instanceId = randomUUID()

    if (config.registerInstance && !config.db && !config.application_name) {
      config.application_name = `pgboss:${instanceId.slice(0, 8)}`
    }

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

    const registrar = new Registrar(instanceId, db, manager, config)

    this.#promoteEvents(manager)
    this.#promoteEvents(boss)
    this.#promoteEvents(timekeeper)
    this.#promoteEvents(bam)
    this.#promoteEvents(navigator)
    this.#promoteEvents(notifier)
    this.#promoteEvents(registrar)

    this.#boss = boss
    this.#contractor = contractor
    this.#manager = manager
    this.#timekeeper = timekeeper
    this.#bam = bam
    this.#navigator = navigator
    this.#notifier = notifier
    this.#registrar = registrar
  }

  #promoteEvents (emitter: types.EventsMixin) {
    for (const event of Object.values(emitter?.events) as (keyof types.PgBossEventMap)[]) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  async start (options: types.StartOptions = {}): Promise<this> {
    const { attempts = 1 } = options

    assert(Number.isInteger(attempts) && attempts >= 1, 'start() attempts must be an integer of 1 or more')

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

    this.#startingPromise = this.#startAttempts(attempts)

    try {
      return await this.#startingPromise
    } finally {
      this.#startingPromise = null
    }
  }

  // Each attempt is the same as calling start() again after a failure, which is safe on the same
  // instance. An AssertionError is pg-boss refusing a configuration it cannot run, which fails the
  // same way every time, so it is thrown at once. Anything else, a database not up yet or a schema
  // another process is still migrating, gets the remaining attempts.
  async #startAttempts (attempts: number): Promise<this> {
    const retry: { cancelled: boolean, wait: AbortablePromise<void> | null } = { cancelled: false, wait: null }
    this.#startRetry = retry

    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.#doStart(attempt)
        } catch (err: any) {
          if (attempt >= attempts || retry.cancelled || err instanceof AssertionError) {
            throw err
          }

          const delaySeconds = Math.min(2 ** (attempt - 1), START_RETRY_MAX_SECONDS)

          // Once per start(), on the first failure: an outage would otherwise repeat it every try.
          if (attempt === 1) {
            this.emit(events.warning, {
              message: `start() failed and will try again, up to ${attempts - 1} more times: ${err?.message}`,
              data: { type: 'start_retry', attempts, error: err?.message }
            })
          }

          retry.wait = delay(delaySeconds * 1000)
          await retry.wait
          retry.wait = null

          if (retry.cancelled) {
            throw err
          }
        }
      }
    } finally {
      this.#startRetry = null
    }
  }

  async #doStart (attempt = 1): Promise<this> {
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

    await this.#registrar.start(attempt)

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
            message: "YugabyteDB detected. YugabyteDB is not supported. Until the next major, backend: 'yugabytedb' avoids the table partitioning and advisory locks that fail there.",
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
    // stop() reads #stopped mid-start and silently no-ops while start() keeps running. One waiting
    // between attempts stops trying, so it fails now with its last error.
    if (this.#startRetry) {
      this.#startRetry.cancelled = true
      this.#startRetry.wait?.abort()
    }

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
      // Pending claims may not have reached worker.jobs when failWip ran. Drain their refusal
      // before closing the pool or publishing stopped.
      await this.#manager.settleCleanups()

      // After the drain, so a graceful stop reads as live until its workers have finished.
      await this.#registrar.stop()

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

    // Real time, not the configured clock: the deadline bounds active-handler grace, and under a test
    // clock nothing would tick it while the test is blocked inside stop().
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => { deadlineTimer = setTimeout(resolve, timeout) })

    try {
      await Promise.race([this.#manager.settleCleanups(), deadline])
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

  previewRedrive (name: string, options?: types.RedrivePreviewOptions): Promise<types.RedrivePreview> {
    return this.#manager.previewRedrive(name, options)
  }

  deleteQueuedJobs (name: string): Promise<number> {
    return this.#manager.deleteQueuedJobs(name)
  }

  deleteStoredJobs (name: string): Promise<number> {
    return this.#manager.deleteStoredJobs(name)
  }

  deleteAllJobs (name?: string): Promise<number | null> {
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

  getBlockedKeys (name: string, options?: types.ListOptions): Promise<string[]> {
    return this.#manager.getBlockedKeys(name, options)
  }

  getDependencies (name: string, id: string, options?: types.ConnectionOptions & types.ListOptions): Promise<types.DependencyRef[]> {
    return this.#manager.getDependencies(name, id, options)
  }

  getDependents (name: string, id: string, options?: types.ConnectionOptions & types.ListOptions): Promise<types.DependencyRef[]> {
    return this.#manager.getDependents(name, id, options)
  }

  updateQueue (name: string, options?: types.UpdateQueueOptions): Promise<void> {
    return this.#manager.updateQueue(name, options)
  }

  deleteQueue (name: string): Promise<void> {
    return this.#manager.deleteQueue(name)
  }

  async getQueues (names?: string[], options?: types.ListOptions): Promise<types.QueueResult[]> {
    return this.#manager.getQueues(names, Attorney.assertListLimit('getQueues', options?.limit))
  }

  getQueue (name: string): Promise<types.QueueResult | null> {
    return this.#manager.getQueue(name)
  }

  getQueueStats (name: string, options?: types.QueueStatsOptions): Promise<types.QueueStats[]> {
    return this.#manager.getQueueStats(name, options)
  }

  async getInstances (options?: types.ListOptions): Promise<types.Instance[]> {
    return this.#registrar.getInstances(Attorney.assertListLimit('getInstances', options?.limit))
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

  unschedule (name: string, key?: string, options?: types.ConnectionOptions): Promise<void> {
    return this.#timekeeper.unschedule(name, key, options)
  }

  async getSchedules (name?: string, key?: string, options?: types.ListOptions): Promise<types.Schedule[]> {
    return this.#timekeeper.getSchedules(name, key, Attorney.assertListLimit('getSchedules', options?.limit))
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

  async getBamEntries (options?: types.ListOptions): Promise<types.BamEntry[]> {
    const limit = Attorney.assertListLimit('getBamEntries', options?.limit)
    const sql = plans.getBamEntries(this.#config.schema)
    const { rows } = await this.#db.executeSql(sql, [limit])
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
  OpenTelemetryOptions,
  PgBossEventMap,
  PreviewScheduleOptions,
  Queue,
  QueueOptions,
  QueuePolicy,
  QueueResult,
  QueueStats,
  QueueStatsPercentile,
  Instance,
  InstanceMetrics,
  InstanceOptions,
  InstanceWorker,
  PoolCounts,
  QueueStatsOptions,
  RedriveFilter,
  RedriveOptions,
  RedrivePreview,
  RedrivePreviewOptions,
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
