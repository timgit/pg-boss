import assert, { notStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import { serializeError as stringify } from 'serialize-error'
import * as Attorney from './attorney.ts'
import type Db from './db.ts'
import type Notifier from './notifier.ts'
import * as plans from './plans.ts'
import type Timekeeper from './timekeeper.ts'
import * as timekeeper from './timekeeper.ts'
import { resolveWithinSeconds } from './tools.ts'
import * as types from './types.ts'
import Worker from './worker.ts'
import { JobSpy, type JobSpyInterface } from './spy.ts'

const INTERNAL_QUEUES = Object.values(timekeeper.QUEUES).reduce<Record<string, string | undefined>>((acc, i) => ({ ...acc, [i]: i }), {})

// CockroachDB returns integer columns (INT8) as strings; these aliased metadata
// fields must be coerced back to numbers when backend === 'cockroachdb'.
const NUMERIC_METADATA_FIELDS = [
  'priority',
  'retryLimit',
  'retryCount',
  'retryDelay',
  'retryDelayMax',
  'expireInSeconds',
  'heartbeatSeconds',
  'deleteAfterSeconds',
  'pendingDependencies'
] as const

// Queue rows (plans.getQueues) return these integer columns as strings on CockroachDB too.
const NUMERIC_QUEUE_FIELDS = [
  'retryLimit',
  'retryDelay',
  'retryDelayMax',
  'expireInSeconds',
  'retentionSeconds',
  'deleteAfterSeconds',
  'heartbeatSeconds',
  'deferredCount',
  'warningQueueSize',
  'queuedCount',
  'activeCount',
  'totalCount'
] as const

const events = {
  error: 'error',
  wip: 'wip'
}

// Standard translation of low-level Postgres errors raised by job-creation SQL
// into actionable pg-boss errors. Centralized so any write path can reuse it.
// Always throws; rethrows untranslated errors unchanged.
function rethrowWriteError (err: any): never {
  // the in-SQL insert guard raises division_by_zero when ON CONFLICT skipped a job
  if (err?.code === plans.PG_ERROR.divisionByZero) {
    throw new Error('one or more jobs could not be created. This usually means a job id was duplicated, collided with an existing job, or was rejected by a queue policy (short, singleton, stately, or exclusive).', { cause: err })
  }

  throw err
}

class Manager extends EventEmitter implements types.EventsMixin {
  events = events
  db: (types.IDatabase & { _pgbdb?: false }) | Db
  config: types.ResolvedConstructorOptions
  wipTs: number
  workers: Map<string, Worker>
  stopped: boolean | undefined
  queueCacheInterval: NodeJS.Timeout | undefined
  wipInterval: NodeJS.Timeout | undefined
  timekeeper: Timekeeper | undefined
  notifier: Notifier | undefined
  queues: Record<string, types.QueueResult> | null
  pendingOffWorkCleanups: Set<Promise<any>>
  #spies: Map<string, JobSpy>
  #localGroupActive: Map<string, Map<string, number>>
  #localGroupConfig: Map<string, types.GroupConcurrencyConfig>
  #localGroupMaxLimit: Map<string, number>

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    super()

    this.config = config
    this.db = db
    this.wipTs = Date.now()
    this.workers = new Map()
    this.queues = {}
    this.pendingOffWorkCleanups = new Set()
    this.#spies = new Map()
    this.#localGroupActive = new Map()
    this.#localGroupConfig = new Map()
    this.#localGroupMaxLimit = new Map()
  }

  getSpy<T = object> (name: string): JobSpyInterface<T> {
    if (!this.config.__test__enableSpies) {
      throw new Error('Spy is not enabled. Set __test__enableSpies: true in constructor options to use spies.')
    }
    let spy = this.#spies.get(name)
    if (!spy) {
      spy = new JobSpy()
      this.#spies.set(name, spy)
    }
    return spy as unknown as JobSpyInterface<T>
  }

  clearSpies (): void {
    for (const spy of this.#spies.values()) {
      spy.clear()
    }
    this.#spies.clear()
  }

  #getLocalGroupLimit (queueName: string, groupTier?: string | null): number {
    const config = this.#localGroupConfig.get(queueName)
    if (!config) return Infinity
    if (groupTier && config.tiers && groupTier in config.tiers) {
      return config.tiers[groupTier]
    }
    return config.default
  }

  #getGroupsAtLocalCapacity (queueName: string): string[] {
    const config = this.#localGroupConfig.get(queueName)
    if (!config) return []

    const queueGroups = this.#localGroupActive.get(queueName)
    if (!queueGroups) return []

    // Only exclude a group from fetching when it has no remaining capacity for
    // any tier. Using config.default alone would exclude groups that still have
    // room for higher tier jobs. Those jobs never reach the per tier check in
    // #trackLocalGroupStart because ignoreGroups filters them out of the fetch
    // query before that point. maxLimit is precomputed once at setup time so
    // Object.values is not called on every fetch cycle.
    const maxLimit = this.#localGroupMaxLimit.get(queueName) ?? config.default

    const atCapacity: string[] = []
    for (const [groupId, activeCount] of queueGroups.entries()) {
      if (activeCount >= maxLimit) {
        atCapacity.push(groupId)
      }
    }
    return atCapacity
  }

  #incrementLocalGroupCount (queueName: string, groupId: string): void {
    let queueGroups = this.#localGroupActive.get(queueName)
    if (!queueGroups) {
      queueGroups = new Map()
      this.#localGroupActive.set(queueName, queueGroups)
    }
    const current = queueGroups.get(groupId) || 0
    queueGroups.set(groupId, current + 1)
  }

  #decrementLocalGroupCount (queueName: string, groupId: string): void {
    const queueGroups = this.#localGroupActive.get(queueName)
    if (!queueGroups) return
    const current = queueGroups.get(groupId) || 0
    if (current <= 1) {
      queueGroups.delete(groupId)
    } else {
      queueGroups.set(groupId, current - 1)
    }
  }

  #trackJobsActive<T> (name: string, jobs: types.Job<T>[]): void {
    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined
    if (spy) {
      for (const job of jobs) {
        spy.addJob(job.id, name, job.data as object, 'active')
      }
    }
  }

  async #trackJobsCompleted<T> (name: string, jobs: types.Job<T>[], result: unknown, affected: number): Promise<void> {
    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined
    if (!spy) return

    // Fast path: complete() transitioned every job (it only touches jobs still in the
    // active state), so the handler's return value is the output for each one.
    if (affected === jobs.length) {
      const output = jobs.length === 1 ? result as object : undefined
      for (const job of jobs) {
        spy.addJob(job.id, name, job.data as object, 'completed', output)
      }
      return
    }

    // Otherwise the handler transitioned one or more jobs itself before returning (e.g. a
    // validation failure routed through boss.fail()), making complete() a no-op for those.
    // Reflect each job's real persisted state rather than assuming completion.
    for (const job of jobs) {
      const persisted = await this.getJobById<object>(name, job.id)
      const state = persisted?.state
      if (state === 'completed' || state === 'failed' || state === 'active' || state === 'created') {
        spy.addJob(job.id, name, job.data as object, state, persisted?.output)
      } else if (!persisted) {
        // The handler deleted the job itself (e.g. boss.deleteJob in the handler), so there is
        // no persisted row to inspect. The handler still returned normally, so from the spy's
        // perspective the work succeeded — record 'completed', matching the behavior before
        // manual-failure tracking was added.
        spy.addJob(job.id, name, job.data as object, 'completed', undefined)
      }
      // 'retry' / 'cancelled' have no spy-state equivalent, so they are intentionally skipped
    }
  }

  async #trackJobsFailed<T> (name: string, jobs: types.Job<T>[], err: Error): Promise<void> {
    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined
    if (!spy) return

    // A handler throw routes through fail(), but fail() only lands the job in the terminal
    // 'failed' state once its retries are exhausted (retry_count >= retry_limit). While retries
    // remain the job goes back to 'retry' and will run again, so recording 'failed' here would be
    // wrong — the spy would report a permanent failure for a job that may yet succeed on retry,
    // and (if the retry does succeed) it would hold contradictory 'failed' + 'completed' entries.
    // Read the real persisted state and only record 'failed' when the job actually failed for good.
    // The eventual outcome of a retried job — success, or terminal failure when retries run out —
    // is recorded by whichever attempt produces it. Mirrors the slow path in #trackJobsCompleted.
    for (const job of jobs) {
      const persisted = await this.getJobById<object>(name, job.id)
      if (persisted?.state === 'failed') {
        spy.addJob(job.id, name, job.data as object, 'failed', persisted.output ?? { message: err?.message, stack: err?.stack })
      }
      // 'retry' / 'created' (retries remaining) have no terminal spy state, so they are skipped.
    }
  }

  #trackJobsSettled<T> (
    name: string,
    completed: { job: types.Job<T>, output: unknown }[],
    failed: { job: types.Job<T>, output: unknown }[]
  ): void {
    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined
    if (!spy) return
    for (const { job, output } of completed) {
      spy.addJob(job.id, name, job.data as object, 'completed', output as object)
    }
    for (const { job, output } of failed) {
      spy.addJob(job.id, name, job.data as object, 'failed', stringify(output) as object)
    }
  }

  // Per-job settlement for `perJobResults` batch handlers. The handler resolves with a JobResult[]
  // describing each job's outcome; we settle completed and failed jobs individually, each with its
  // own output. All completed jobs are settled in a single statement and all failed jobs in another
  // (each output carried per-id via a JSON recordset), so batch size never drives the statement
  // count. Any batch job the handler omits (or returns with an invalid shape) is failed with a
  // descriptive error so it retries / dead-letters per queue config.
  async #settlePerJob<T> (name: string, jobs: types.Job<T>[], result: unknown): Promise<void> {
    if (!Array.isArray(result)) {
      // The handler opted into perJobResults but did not return an array: a contract violation.
      // Fail the whole batch so the mistake surfaces and the jobs are retried.
      const err = new Error('perJobResults handler must resolve with an array of job results')
      await this.fail(name, jobs.map(job => job.id), err)
      this.#trackJobsFailed(name, jobs, err)
      return
    }

    // Index the handler's dispositions by job id, keeping only valid entries that reference a job
    // from this batch. Last write wins on duplicate ids.
    const batch = new Map(jobs.map(job => [job.id, job]))
    const disposition = new Map<string, types.JobResult>()
    for (const item of result as types.JobResult[]) {
      if (item && batch.has(item.id) && (item.status === 'completed' || item.status === 'failed' || item.status === 'deadletter')) {
        disposition.set(item.id, item)
      }
    }

    // Partition the batch (the authoritative set of jobs) by disposition. `deadletter` jobs fail
    // terminally and route straight to the dead letter queue, bypassing remaining retries.
    const completed: { job: types.Job<T>, output: unknown }[] = []
    const failed: { job: types.Job<T>, output: unknown }[] = []
    const deadLettered: { job: types.Job<T>, output: unknown }[] = []
    for (const job of jobs) {
      const item = disposition.get(job.id)
      if (item?.status === 'completed') {
        completed.push({ job, output: item.output })
      } else if (item?.status === 'failed') {
        failed.push({ job, output: item.output })
      } else if (item?.status === 'deadletter') {
        deadLettered.push({ job, output: item.output })
      } else {
        failed.push({ job, output: new Error('no disposition returned by handler') })
      }
    }

    if (completed.length > 0) {
      await this.#completeWithOutputs(name, completed.map(c => ({ id: c.job.id, output: c.output })))
    }
    if (failed.length > 0) {
      await this.#failWithOutputs(name, failed.map(f => ({ id: f.job.id, output: f.output })))
    }
    if (deadLettered.length > 0) {
      await this.#failWithOutputs(name, deadLettered.map(d => ({ id: d.job.id, output: d.output })), true)
    }

    // Dead lettered jobs end in the same terminal `failed` state as failed jobs on the source queue.
    this.#trackJobsSettled(name, completed, [...failed, ...deadLettered])
  }

  // Complete a set of active jobs, each with its own output, in a constant number of statements
  // (one on Postgres, two on a distributed backend). Outputs are serialized like complete()/fail()
  // and passed as a JSON recordset so the batch size doesn't drive the statement count.
  async #completeWithOutputs (name: string, items: { id: string, output: unknown }[]): Promise<types.CommandResponse> {
    const { table } = await this.getQueueCache(name)
    const payload = items.map(item => ({ id: item.id, output: this.mapCompletionDataArg(item.output) }))
    const ids = items.map(item => item.id)

    if (this.config.noMultiMutationCte) {
      return this.withDistributedTransaction(this.db, async (tx) => {
        const sql = plans.completeJobsWithOutputsDistributed(this.config.schema, table)
        const { rows } = await tx.executeSql(sql, [name, JSON.stringify(payload)])
        const blockingIds = rows.filter(row => row.blocking).map(row => row.id)
        if (blockingIds.length > 0) {
          await tx.executeSql(plans.decrementDependents(this.config.schema), [name, blockingIds])
        }
        return { jobs: ids, requested: ids.length, affected: rows.length }
      })
    }

    const sql = plans.completeJobsWithOutputs(this.config.schema, table)
    const result = await this.db.executeSql(sql, [name, JSON.stringify(payload)])
    return this.mapCommandResponse(ids, result)
  }

  // Fail a set of active jobs, each with its own output, in a constant number of statements. On a
  // distributed backend this reuses the select -> delete -> reinsert split, passing per-id outputs
  // to reinsertFailedJobs so each job keeps its own failure detail. When `forceTerminal` is set the
  // jobs fail terminally and route straight to the dead letter queue, bypassing remaining retries.
  async #failWithOutputs (name: string, items: { id: string, output: unknown }[], forceTerminal = false): Promise<types.CommandResponse> {
    const { table } = await this.getQueueCache(name)
    const ids = items.map(item => item.id)

    if (this.config.noMultiMutationCte) {
      const outputById = new Map(items.map(item => [item.id, this.mapCompletionDataArg(item.output)]))
      return this.withDistributedTransaction(this.db, async (tx) => {
        const selectQuery = plans.selectJobsToFailById(this.config.schema, table)
        const { rows: jobs } = await tx.executeSql(selectQuery.text, [name, ids])

        if (jobs.length === 0) {
          return { jobs: ids, requested: ids.length, affected: 0 }
        }

        const deleteQuery = plans.deleteJobsToFail(this.config.schema, table)
        await tx.executeSql(deleteQuery.text, [name, ids])

        const count = await this.reinsertFailedJobs(tx, table, jobs, null, outputById, forceTerminal)
        return { jobs: ids, requested: ids.length, affected: count }
      })
    }

    const payload = items.map(item => ({ id: item.id, output: this.mapCompletionDataArg(item.output) }))
    const sql = forceTerminal
      ? plans.deadLetterJobsByIdWithOutputs(this.config.schema, table)
      : plans.failJobsByIdWithOutputs(this.config.schema, table)
    const result = await this.db.executeSql(sql, [name, JSON.stringify(payload)])
    return this.mapCommandResponse(ids, result)
  }

  #storeLocalGroupConfig (name: string, localGroupConcurrency: number | types.GroupConcurrencyConfig): void {
    const config: types.GroupConcurrencyConfig = typeof localGroupConcurrency === 'number'
      ? { default: localGroupConcurrency }
      : localGroupConcurrency
    this.#localGroupConfig.set(name, config)
    this.#localGroupMaxLimit.set(name, config.tiers
      ? Math.max(config.default, ...Object.values(config.tiers))
      : config.default)
  }

  #cleanupLocalGroupTracking (name: string): void {
    // Only cleanup if no more workers exist for this queue
    const hasWorkersForQueue = this.getWorkers().some(w => w.name === name && !w.stopping && !w.stopped)
    if (!hasWorkersForQueue) {
      this.#localGroupConfig.delete(name)
      this.#localGroupActive.delete(name)
      this.#localGroupMaxLimit.delete(name)
    }
  }

  #trackLocalGroupStart<T> (
    name: string,
    jobs: types.Job<T>[]
  ): { allowed: types.Job<T>[], excess: types.Job<T>[], groupedJobs: types.Job<T>[] } {
    const allowed: types.Job<T>[] = []
    const excess: types.Job<T>[] = []
    const groupedJobs: types.Job<T>[] = []

    for (const job of jobs) {
      if (!job.groupId) {
        // Jobs without group bypass local group limits
        allowed.push(job)
        continue
      }

      const currentCount = this.#localGroupActive.get(name)?.get(job.groupId) || 0
      const limit = this.#getLocalGroupLimit(name, job.groupTier)

      if (currentCount < limit) {
        this.#incrementLocalGroupCount(name, job.groupId)
        allowed.push(job)
        groupedJobs.push(job)
      } else {
        excess.push(job)
      }
    }

    return { allowed, excess, groupedJobs }
  }

  #trackLocalGroupEnd<T> (name: string, groupedJobs: types.Job<T>[]): void {
    for (const job of groupedJobs) {
      if (job.groupId) {
        this.#decrementLocalGroupCount(name, job.groupId)
      }
    }
  }

  async #processJobs<T> (
    name: string,
    jobs: types.Job<T>[],
    callback: types.WorkHandler<T>,
    worker?: Worker<T>,
    heartbeatRefreshSeconds?: number,
    perJobResults = false
  ): Promise<void> {
    const jobIds = jobs.map(job => job.id)
    const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expireInSeconds), 0)
    const heartbeatSeconds = jobs.reduce((acc, j) => Math.max(acc, j.heartbeatSeconds || 0), 0)
    const ac = new AbortController()
    jobs.forEach(job => { job.signal = ac.signal })

    // Store AbortController on worker so it can be aborted after graceful shutdown
    if (worker) {
      worker.abortController = ac
    }

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null

    if (heartbeatSeconds > 0) {
      const refreshSeconds = heartbeatRefreshSeconds ?? (heartbeatSeconds / 2)
      const intervalMs = refreshSeconds * 1000
      heartbeatTimer = setInterval(async () => {
        try {
          await this.touch(name, jobIds)
        } catch (err) {
          this.emit(events.error, err)
        }
      }, intervalMs)
    }

    let completedResult: unknown
    let completedAffected = 0
    let failedError: any
    let didFail = false

    try {
      const result = await resolveWithinSeconds(callback(jobs), maxExpiration, `handler execution exceeded ${maxExpiration}s`, ac)
      if (perJobResults) {
        // #settlePerJob settles each job individually and does its own (synchronous,
        // lookup-free) spy tracking via #trackJobsSettled, so the deferred tracker below
        // is skipped for this path.
        await this.#settlePerJob(name, jobs, result)
      } else {
        const completion = await this.complete(name, jobIds, jobIds.length === 1 ? result : undefined)
        completedResult = result
        completedAffected = completion.affected
      }
    } catch (err: any) {
      await this.fail(name, jobIds, err)
      failedError = err
      didFail = true
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (worker) {
        // Clear between jobs
        worker.abortController = null
      }
    }

    // Spy tracking runs after the completion/failure logic so a spy lookup error can never
    // be mistaken for a handler failure and re-route the job through fail(). The flag is
    // gated here, not just inside the trackers, so the production hot path (spies off) never
    // even calls the async tracker — no promise allocated, no microtask tick. The checks
    // inside the trackers stay as a safety net.
    if (this.config.__test__enableSpies && this.#spies.has(name)) {
      if (didFail) {
        await this.#trackJobsFailed(name, jobs, failedError)
      } else if (!perJobResults) {
        // perJobResults already tracked inside #settlePerJob; tracking again here would
        // double-record (and overwrite per-job outputs with the batch's slow-path lookup).
        await this.#trackJobsCompleted(name, jobs, completedResult, completedAffected)
      }
    }
  }

  async start () {
    this.stopped = false
    this.queueCacheInterval = setInterval(() => this.onCacheQueues({ emit: true }), this.config.queueCacheIntervalSeconds! * 1000)
    this.wipInterval = setInterval(() => {
      const now = Date.now()
      if ((now - this.wipTs) < 2000) {
        return
      }

      const wip = this.getWipData()
      if (wip.some(w => w.count > 0)) {
        this.emit(events.wip, wip)
        this.wipTs = now
      }
    }, 2000)
    await this.onCacheQueues()
  }

  async onCacheQueues ({ emit = false } = {}) {
    try {
      assert(!this.config.__test__throw_queueCache, 'test error')
      const queues = await this.getQueues()
      this.queues = queues.reduce<Record<string, types.QueueResult>>((acc, i) => { acc[i.name] = i; return acc }, {})
    } catch (error: any) {
      emit && this.emit(events.error, { ...error, message: error.message, stack: error.stack })
    }
  }

  async getQueueCache (name: string): Promise<types.QueueResult> {
    assert(this.queues, 'Queue cache is not initialized')

    let queue = this.queues[name]

    if (queue) {
      return queue
    }

    queue = await this.getQueue(name)

    if (!queue) {
      throw new Error(`Queue ${name} does not exist`)
    }

    this.queues[name] = queue

    return queue
  }

  async stop () {
    this.stopped = true

    clearInterval(this.queueCacheInterval)
    clearInterval(this.wipInterval)

    await Promise.allSettled(
      [...this.workers.values()]
        .filter(worker => !INTERNAL_QUEUES[worker.name])
        .map(async worker => await this.offWork(worker.name, { wait: false }))
    )

    // Clean up all local group tracking on full stop
    this.#localGroupConfig.clear()
    this.#localGroupActive.clear()
    this.#localGroupMaxLimit.clear()
  }

  async failWip () {
    for (const worker of this.workers.values()) {
      const jobIds = worker.jobs.map(j => j.id)
      if (jobIds.length) {
        await this.fail(worker.name, jobIds, 'pg-boss shut down while active')
      }
      worker.abort()
    }
  }

  work<ReqData>(name: string, handler: types.WorkHandler<ReqData>): Promise<string>
  work<ReqData, const O extends types.WorkOptions = types.WorkOptions>(name: string, options: O, handler: types.WorkHandlerFor<O, ReqData>): Promise<string>
  async work<ReqData> (name: string, ...args: unknown[]): Promise<string> {
    const { options, callback } = Attorney.checkWorkArgs(name, args)

    if (this.stopped) {
      throw new Error('Workers are disabled. pg-boss is stopped')
    }

    const {
      pollingInterval: interval,
      notifyPollingInterval: notifyInterval,
      burstWhenReadyExceeds,
      burstWhenBatchFull = false,
      batchSize = 1,
      includeMetadata = false,
      priority = true,
      localConcurrency = 1,
      localGroupConcurrency,
      groupConcurrency,
      orderByCreatedOn = true,
      heartbeatRefreshSeconds,
      minPriority,
      maxPriority,
      perJobResults = false,
    } = options

    if (localGroupConcurrency != null) {
      this.#storeLocalGroupConfig(name, localGroupConcurrency)
    }

    const firstWorkerId = randomUUID({ disableEntropyCache: true })

    // NOTIFY is only doing the fast-path wakeups when the queue opted in (notify) AND the
    // instance listener is established.
    const isNotifyActive = () => !!(this.notifier?.available && this.queues?.[name]?.notify)

    // Runnable backlog from the cached queue stats, refreshed every queueCacheIntervalSeconds.
    const getReadyCount = () => this.queues?.[name]?.readyCount ?? 0

    // Resolve the delay before each fetch. Precedence: burst (fetch continuously) > NOTIFY
    // backstop > base poll. Evaluated per-iteration so it tracks live cache/notify state and
    // any updateQueue notify toggles.
    //
    // A burst trigger only engages while the last fetch came back full (>= batchSize). That is
    // both the meaning of burstWhenBatchFull and the anti-hot-loop guard for burstWhenReadyExceeds:
    // the cached ready count lags reality, so a short fetch (including 0 < 1 at the default batchSize)
    // means the queue has likely caught up — fall back to normal polling instead of spinning on
    // empty fetches. burstWhenBatchFull is ignored at batchSize 1 (every fetch would be "full").
    const resolveInterval = (lastFetchCount: number) => {
      const fullBatch = lastFetchCount >= batchSize
      const burst = fullBatch && (
        (burstWhenReadyExceeds !== undefined && getReadyCount() > burstWhenReadyExceeds) ||
        (burstWhenBatchFull && batchSize > 1)
      )

      if (burst) return 0
      return isNotifyActive() ? notifyInterval : interval
    }

    const createWorker = (workerId: string, workId: string) => {
      const fetch = () => {
        const ignoreGroups = localGroupConcurrency != null
          ? this.#getGroupsAtLocalCapacity(name)
          : undefined
        return this.fetch<ReqData>(name, { batchSize, includeMetadata, priority, orderByCreatedOn, groupConcurrency, ignoreGroups, minPriority, maxPriority })
      }

      const onFetch = async (jobs: types.Job<ReqData>[]) => {
        if (!jobs.length) return
        if (this.config.__test__throw_worker) throw new Error('__test__throw_worker')

        this.emitWip(name)
        this.#trackJobsActive(name, jobs)

        // Get the worker instance for abort controller tracking
        const worker = this.workers.get(workerId)

        // Skip all in-memory group tracking when localGroupConcurrency is not enabled
        if (localGroupConcurrency == null) {
          await this.#processJobs(name, jobs, callback, worker, heartbeatRefreshSeconds, perJobResults)
        } else {
          const { allowed, excess, groupedJobs } = this.#trackLocalGroupStart(name, jobs)

          if (excess.length > 0) {
            const excessIds = excess.map(job => job.id)
            await this.restore(name, excessIds)
          }

          if (allowed.length > 0) {
            try {
              await this.#processJobs(name, allowed, callback, worker, heartbeatRefreshSeconds, perJobResults)
            } finally {
              this.#trackLocalGroupEnd(name, groupedJobs)
            }
          }
        }

        this.emitWip(name)
      }

      const onError = (error: any) => {
        this.emit(events.error, { ...error, message: error.message, stack: error.stack, queue: name, worker: workerId })
      }

      return new Worker<ReqData>({ id: workerId, workId, name, options, resolveInterval, fetch, onFetch, onError })
    }

    // Spawn workers based on localConcurrency setting
    for (let i = 0; i < localConcurrency; i++) {
      const workerId = i === 0 ? firstWorkerId : randomUUID({ disableEntropyCache: true })
      const worker = createWorker(workerId, firstWorkerId)

      this.addWorker(worker)
      worker.start()
    }

    return firstWorkerId
  }

  private addWorker (worker: Worker<any>) {
    this.workers.set(worker.id, worker)
  }

  private removeWorker (worker: Worker<any>) {
    this.workers.delete(worker.id)
  }

  private getWorkers () {
    return Array.from(this.workers.values())
  }

  private emitWip (name: string) {
    if (!INTERNAL_QUEUES[name]) {
      const now = Date.now()

      if (now - this.wipTs > 2000) {
        this.emit(events.wip, this.getWipData())
        this.wipTs = now
      }
    }
  }

  getWipData (options: { includeInternal?: boolean } = {}) {
    const { includeInternal = false } = options

    const data = this.getWorkers()
      .map(i => i.toWipData())
      .filter(i => i.state !== 'stopped' && (!INTERNAL_QUEUES[i.name] || includeInternal))

    return data
  }

  hasPendingCleanups (): boolean {
    return this.pendingOffWorkCleanups.size > 0
  }

  async offWork (name: string, options: types.OffWorkOptions = { wait: true }): Promise<void> {
    assert(name, 'queue name is required')
    assert(typeof name === 'string', 'queue name must be a string')

    const query = (i: Worker<any>) => options?.id ? i.id === options.id : i.name === name

    const workers = this.getWorkers().filter(i => query(i) && !i.stopping && !i.stopped)

    if (workers.length === 0) {
      return
    }

    const cleanupPromise = Promise.allSettled(
      workers.map(async worker => {
        await worker.stop()
        this.removeWorker(worker)
      }))

    if (options.wait) {
      await cleanupPromise
      this.#cleanupLocalGroupTracking(name)
    } else {
      this.pendingOffWorkCleanups.add(cleanupPromise)
      cleanupPromise.finally(() => {
        this.pendingOffWorkCleanups.delete(cleanupPromise)
        this.#cleanupLocalGroupTracking(name)
      })
    }
  }

  notifyWorker (workerId: string): void {
    this.workers.get(workerId)?.notify()
  }

  // Whether a queue's `notify` opt-in actually emits a transactional pg_notify. Backends that
  // don't implement LISTEN/NOTIFY (noListenNotify, e.g. CockroachDB) would error on the inlined
  // pg_notify, so the producer falls back to polling-only delivery on those.
  #notifyEnabled (queueNotify: boolean | undefined): boolean {
    return !!queueNotify && !this.config.noListenNotify
  }

  // Wake every worker on a queue so it fetches now instead of waiting out its poll delay.
  // Called by the LISTEN/NOTIFY listener when a job lands on a notify-enabled queue.
  notifyQueue (name: string): void {
    for (const worker of this.workers.values()) {
      if (worker.name === name) {
        worker.notify()
      }
    }
  }

  // Gap recovery: after the listener (re)connects, notifications emitted during the
  // outage were missed, so force every worker on a notify-enabled queue to fetch once.
  forceFetchLnWorkers (): void {
    for (const worker of this.workers.values()) {
      if (this.queues?.[worker.name]?.notify) {
        worker.notify()
      }
    }
  }

  async subscribe (event: string, name: string): Promise<void> {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')
    const sql = plans.subscribe(this.config.schema)
    await this.db.executeSql(sql, [event, name])
  }

  async unsubscribe (event: string, name: string): Promise<void> {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')
    const sql = plans.unsubscribe(this.config.schema)
    await this.db.executeSql(sql, [event, name])
  }

  publish (event: string, data?: object, options?: types.SendOptions): Promise<void>
  async publish (event: string, data?: object, options?: types.SendOptions): Promise<void> {
    assert(event, 'Missing required argument')
    const sql = plans.getQueuesForEvent(this.config.schema)
    const { rows } = await this.db.executeSql(sql, [event])

    await Promise.allSettled(rows.map(({ name }) => this.send(name, data, options)))
  }

  send (request: types.Request): Promise<string | null>
  send (name: string, data?: object | null, options?: types.SendOptions | null): Promise<string | null>
  async send (...args: any[]): Promise<string | null> {
    const result = Attorney.checkSendArgs(args)

    return await this.createJob(result)
  }

  async sendAfter (name: string, data: object | null, options: types.SendOptions | null, after: Date | string | number): Promise<string | null> {
    options = options ? { ...options } : {}
    options.startAfter = after

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result)
  }

  async sendThrottled (name: string, data: object | null, options: types.SendOptions | null, seconds: number, key?: string): Promise<string | null> {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result)
  }

  async sendDebounced (name: string, data: object | null, options: types.SendOptions | null, seconds: number, key?: string): Promise<string | null> {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result)
  }

  async createJob (request: types.Request): Promise<string | null> {
    const { name, data = null, options = {} } = request
    const {
      id = null,
      db: wrapper,
      priority,
      startAfter,
      singletonKey = null,
      singletonSeconds,
      singletonNextSlot,
      expireInSeconds,
      deleteAfterSeconds,
      retentionSeconds,
      keepUntil,
      retryLimit,
      retryDelay,
      retryBackoff,
      retryDelayMax,
      heartbeatSeconds,
      group,
      deadLetter = null
    } = options

    const job = {
      id,
      name,
      data,
      priority,
      startAfter,
      singletonKey,
      singletonSeconds,
      singletonOffset: 0 as number | undefined,
      groupId: group?.id ?? null,
      groupTier: group?.tier ?? null,
      expireInSeconds,
      deleteAfterSeconds,
      retentionSeconds,
      keepUntil,
      retryLimit,
      retryDelay,
      retryBackoff,
      retryDelayMax,
      heartbeatSeconds,
      deadLetter
    }

    const db = wrapper || this.db

    const { table, policy, notify } = await this.getQueueCache(name)

    if (policy === plans.QUEUE_POLICIES.key_strict_fifo && !singletonKey) {
      throw new Error(`${plans.QUEUE_POLICIES.key_strict_fifo} queues require a singletonKey`)
    }

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId: true, notify: this.#notifyEnabled(notify) })

    const { rows: try1 } = await db.executeSql(sql, [JSON.stringify([job])])

    if (try1.length === 1) {
      const jobId = try1[0].id
      if (this.config.__test__enableSpies) {
        const spy = this.#spies.get(name)
        if (spy) {
          spy.addJob(jobId, name, data || {}, 'created')
        }
      }
      return jobId
    }

    if (singletonNextSlot) {
      // delay starting by the offset to honor throttling config
      job.startAfter = this.getDebounceStartAfter(singletonSeconds!, this.timekeeper!.clockSkew)
      job.singletonOffset = singletonSeconds

      const { rows: try2 } = await db.executeSql(sql, [JSON.stringify([job])])

      if (try2.length === 1) {
        const jobId = try2[0].id
        if (this.config.__test__enableSpies) {
          const spy = this.#spies.get(name)
          if (spy) {
            spy.addJob(jobId, name, data || {}, 'created')
          }
        }
        return jobId
      }
    }

    return null
  }

  async insert (
    name: string,
    jobs: types.JobInsert[],
    options: types.InsertOptions = {}
  ) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const { table, policy, notify } = await this.getQueueCache(name)

    if (policy === plans.QUEUE_POLICIES.key_strict_fifo) {
      for (const job of jobs) {
        if (!job.singletonKey) {
          throw new Error(`${plans.QUEUE_POLICIES.key_strict_fifo} queues require a singletonKey`)
        }
      }
    }

    const insertPayload = jobs.map(j => {
      const {
        blocked,
        blocking,
        pendingDependencies,
        ...rest
      } = j as types.JobInsert & { blocked?: unknown, blocking?: unknown, pendingDependencies?: unknown }

      return rest
    })

    const db = this.assertDb(options)

    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined

    // Return IDs if spy is active for this queue (needed for job tracking)
    const returnId = !!spy || !!options.returnId

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId, notify: this.#notifyEnabled(notify) })

    const { rows } = await db.executeSql(sql, [JSON.stringify(insertPayload)])

    if (rows.length) {
      if (spy) {
        for (let i = 0; i < rows.length; i++) {
          spy.addJob(rows[i].id, name, jobs[i].data || {}, 'created')
        }
      }
      return rows.map((i): string => i.id)
    }

    return null
  }

  async flow (jobs: types.FlowJob[], options: types.ConnectionOptions = {}): Promise<Record<string, string>> {
    Attorney.validateFlowJobs(jobs)

    // validate and normalize each job's options the same way send()/insert() do
    const flowJobs = jobs.map(job => ({
      ...job,
      options: Attorney.checkSendArgs([{ name: job.name, data: job.data, options: job.options }]).options
    }))

    const refToId: Record<string, string> = {}
    for (const job of flowJobs) {
      refToId[job.ref] = job.options?.id ?? randomUUID()
    }

    const refToJob = new Map(flowJobs.map(job => [job.ref, job]))
    const dependencyCountByRef = new Map<string, number>()
    const parentRefs = new Set<string>()
    const depRows: { child_name: string, child_id: string, parent_name: string, parent_id: string }[] = []

    for (const job of flowJobs) {
      const dependsOn = [...new Set(job.dependsOn ?? [])]
      dependencyCountByRef.set(job.ref, dependsOn.length)

      for (const depRef of dependsOn) {
        const parentJob = refToJob.get(depRef)!
        parentRefs.add(depRef)
        depRows.push({
          child_name: job.name,
          child_id: refToId[job.ref],
          parent_name: parentJob.name,
          parent_id: refToId[depRef]
        })
      }
    }

    const byQueue = new Map<string, typeof flowJobs>()
    for (const job of flowJobs) {
      const group = byQueue.get(job.name) || []
      group.push(job)
      byQueue.set(job.name, group)
    }

    // Build one self-contained, parameter-less statement list so the whole flow
    // commits atomically in a single executeSql call, regardless of db adapter.
    // Each insert is guarded so a skipped row (ON CONFLICT) aborts the transaction.
    const statements: string[] = []

    for (const [queueName, queueJobs] of byQueue) {
      const { table, notify } = await this.getQueueCache(queueName)

      const insertPayload = queueJobs.map(j => {
        const dependencyCount = dependencyCountByRef.get(j.ref) ?? 0
        return {
          id: refToId[j.ref],
          name: queueName,
          data: j.data ?? null,
          priority: j.options?.priority,
          startAfter: j.options?.startAfter,
          singletonKey: j.options?.singletonKey ?? undefined,
          singletonSeconds: j.options?.singletonSeconds,
          groupId: j.options?.group?.id ?? undefined,
          groupTier: j.options?.group?.tier ?? undefined,
          expireInSeconds: j.options?.expireInSeconds,
          deleteAfterSeconds: j.options?.deleteAfterSeconds,
          retentionSeconds: j.options?.retentionSeconds,
          retryLimit: j.options?.retryLimit,
          retryDelay: j.options?.retryDelay,
          retryBackoff: j.options?.retryBackoff,
          retryDelayMax: j.options?.retryDelayMax,
          heartbeatSeconds: j.options?.heartbeatSeconds,
          deadLetter: j.options?.deadLetter ?? undefined,
          blocked: dependencyCount > 0 || undefined,
          blocking: parentRefs.has(j.ref) || undefined,
          pendingDependencies: dependencyCount || undefined
        }
      })

      statements.push(plans.insertFlowJobs(this.config.schema, { table, name: queueName }, insertPayload))

      // Wake workers for notify-enabled queues. Runs in the same transaction as the
      // inserts above, so it commits atomically. Blocked children and future-dated roots
      // are harmless: the fetch query filters them out, so a wake just triggers one fetch
      // that picks up whatever roots are immediately runnable.
      if (this.#notifyEnabled(notify)) {
        statements.push(plans.notifyQueue(this.config.schema, queueName))
      }
    }

    if (depRows.length > 0) {
      statements.push(plans.insertDependencies(this.config.schema, depRows))
    }

    // When the caller provides a db they own the transaction; otherwise wrap the
    // statements so they run atomically as a single round-trip on any adapter.
    const db = options.db ?? this.db
    const sql = options.db ? statements.join(';\n') : plans.transaction(statements)

    try {
      await db.executeSql(sql)
    } catch (err) {
      rethrowWriteError(err)
    }

    return refToId
  }

  getDebounceStartAfter (singletonSeconds: number, clockOffset: number) {
    const debounceInterval = singletonSeconds * 1000

    const now = Date.now() + clockOffset

    const slot = Math.floor(now / debounceInterval) * debounceInterval

    // prevent startAfter=0 during debouncing
    let startAfter = (singletonSeconds - Math.floor((now - slot) / 1000)) || 1

    if (singletonSeconds > 1) {
      startAfter++
    }

    return startAfter
  }

  fetch<T>(name: string): Promise<types.Job<T>[]>
  fetch<T>(name: string, options: types.FetchOptions & { includeMetadata: true }): Promise<types.JobWithMetadata<T>[]>
  fetch<T>(name: string, options: types.FetchOptions): Promise<types.Job<T>[]>
  async fetch (name: string, options: types.FetchOptions = {}) {
    Attorney.checkFetchArgs(name, options)

    const db = this.assertDb(options)

    const { table, policy, singletonsActive } = await this.getQueueCache(name)

    const fetchOptions = {
      ...options,
      schema: this.config.schema,
      table,
      name,
      policy,
      limit: options.batchSize || 1,
      ignoreSingletons: singletonsActive
    }

    const query = plans.fetchNextJob(fetchOptions, this.config.noSkipLocked)

    let result

    try {
      result = await db.executeSql(query.text, query.values)
    } catch (err) {
      // errors from fetchquery should only be unique constraint violations
    }

    const rows = result?.rows || []

    // CockroachDB returns integer columns as strings; normalize them. Even a minimal fetch
    // (JOB_COLUMNS_MIN) returns numeric fields like expireInSeconds/heartbeatSeconds, so normalize
    // regardless of includeMetadata. The columns are aliased to camelCase, so use those keys.
    if (this.config.backend === 'cockroachdb') {
      for (const row of rows) {
        for (const field of NUMERIC_METADATA_FIELDS) {
          if (row[field] !== undefined && row[field] !== null) row[field] = Number(row[field])
        }
      }
    }

    return rows
  }

  private mapCompletionIdArg (id: string | string[], funcName: string) {
    const errorMessage = `${funcName}() requires an id`

    assert(id, errorMessage)

    const ids = Array.isArray(id) ? id : [id]

    assert(ids.length, errorMessage)

    return ids
  }

  private mapCompletionDataArg (data?: unknown) {
    if (data === null || typeof data === 'undefined' || typeof data === 'function') { return null }

    const result = (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value: data }

    return stringify(result)
  }

  private mapCommandResponse (ids: string[], result: { rows: any[] } | null): types.CommandResponse {
    return {
      jobs: ids,
      requested: ids.length,
      affected: result && result.rows ? parseInt(result.rows[0].count) : 0
    }
  }

  async complete (name: string, id: string | string[], data?: object | null, options: types.CompleteOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'complete')
    const { table } = await this.getQueueCache(name)
    const outputData = this.mapCompletionDataArg(data)

    // noMultiMutationCte: split the dependency-unblocking into a separate statement to
    // avoid CockroachDB's multi-mutation CTE limitation (completeJobs updates two tables).
    if (this.config.noMultiMutationCte) {
      return this.completeDistributed(name, ids, outputData, table, db, options.includeQueued)
    }

    const sql = plans.completeJobs(this.config.schema, table, options.includeQueued)
    const result = await db.executeSql(sql, [name, ids, outputData])
    return this.mapCommandResponse(ids, result)
  }

  // Distributed complete/fail need several statements run atomically. When we own the pooled
  // connection we pin a single client via withTransaction(); when the caller supplied their own
  // db (options.db) we run the statements inline so they compose inside the caller's transaction
  // rather than issuing a BEGIN/COMMIT that would commit or roll back their outer work.
  private async withDistributedTransaction<T> (db: types.IDatabase, fn: (tx: types.IDatabase) => Promise<T>): Promise<T> {
    if (db === this.db && this.db._pgbdb) {
      return this.db.withTransaction(fn)
    }

    return fn(db)
  }

  private async completeDistributed (name: string, ids: string[], outputData: any, table: string, db: types.IDatabase, includeQueued?: boolean): Promise<types.CommandResponse> {
    return this.withDistributedTransaction(db, async (tx) => {
      // Step 1: Mark jobs completed and learn which ones were blocking dependents
      const completeSql = plans.completeJobsDistributed(this.config.schema, table, includeQueued)
      const { rows } = await tx.executeSql(completeSql, [name, ids, outputData])

      // Step 2: Decrement pending_dependencies for children of completed blocking parents
      const blockingIds = rows.filter(row => row.blocking).map(row => row.id)
      if (blockingIds.length > 0) {
        const decrementSql = plans.decrementDependents(this.config.schema)
        await tx.executeSql(decrementSql, [name, blockingIds])
      }

      return { jobs: ids, requested: ids.length, affected: rows.length }
    })
  }

  async fail (name: string, id: string | string[], data?: any, options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'fail')
    const { table } = await this.getQueueCache(name)
    const outputData = this.mapCompletionDataArg(data)

    // noMultiMutationCte: use separate queries to avoid CockroachDB's multi-mutation CTE limitation.
    // The delete and re-insert run in a single transaction (see withDistributedTransaction) so the
    // job cannot be lost between the two statements.
    if (this.config.noMultiMutationCte) {
      return this.failDistributed(name, ids, outputData, table, db)
    }

    const sql = plans.failJobsById(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids, outputData])
    return this.mapCommandResponse(ids, result)
  }

  private async failDistributed (name: string, ids: string[], outputData: any, table: string, db: types.IDatabase): Promise<types.CommandResponse> {
    // CockroachDB doesn't support multi-mutation CTEs, but does support transactions, so the
    // delete + re-insert is split into separate statements run atomically.
    return this.withDistributedTransaction(db, async (tx) => {
      // Step 1: Select jobs to fail
      const selectQuery = plans.selectJobsToFailById(this.config.schema, table)
      const { rows: jobs } = await tx.executeSql(selectQuery.text, [name, ids])

      if (jobs.length === 0) {
        return { jobs: ids, requested: ids.length, affected: 0 }
      }

      // Step 2: Delete the jobs
      const deleteQuery = plans.deleteJobsToFail(this.config.schema, table)
      await tx.executeSql(deleteQuery.text, [name, ids])

      // Step 3: Re-insert jobs with updated state
      const count = await this.reinsertFailedJobs(tx, table, jobs, outputData)

      return { jobs: ids, requested: ids.length, affected: count }
    })
  }

  // Distributed equivalents of the supervisor's failJobsByTimeout/failJobsByHeartbeat maintenance.
  // Those use the multi-mutation failJobs() CTE, which CockroachDB rejects, so on a distributed
  // database we select the expired/timed-out jobs, delete them, and re-insert as retry/failed in a
  // single transaction (the same split as failDistributed). Always run on the pooled connection.
  async failJobsByTimeoutDistributed (table: string, queues: string[]): Promise<number> {
    const select = plans.selectJobsToFailByTimeout(this.config.schema, table, queues)
    return this.expireJobsDistributed(table, select, { value: { message: 'job timed out' } })
  }

  async failJobsByHeartbeatDistributed (table: string, queues: string[]): Promise<number> {
    const select = plans.selectJobsToFailByHeartbeat(this.config.schema, table, queues)
    return this.expireJobsDistributed(table, select, { value: { message: 'job heartbeat timeout' } })
  }

  private async expireJobsDistributed (table: string, select: plans.SqlQuery, outputData: any): Promise<number> {
    return this.withDistributedTransaction(this.db, async (tx) => {
      const { rows: jobs } = await tx.executeSql(select.text, [])

      if (jobs.length === 0) {
        return 0
      }

      const ids = jobs.map(job => job.id)
      const deleteSql = plans.deleteJobsByIds(this.config.schema, table)
      await tx.executeSql(deleteSql.text, [ids])

      return this.reinsertFailedJobs(tx, table, jobs, outputData)
    })
  }

  // Re-insert a set of just-deleted jobs as retry (when retries remain) or failed (+ dead letter),
  // preserving the flow/heartbeat columns. Shared by failDistributed and the distributed
  // maintenance expiry above. Returns the number of jobs processed.
  private async reinsertFailedJobs (tx: types.IDatabase, table: string, jobs: any[], outputData: any, outputById?: Map<string, any>, forceTerminal = false): Promise<number> {
    const insertSql = plans.insertRetryJob(this.config.schema, table)
    const dlqSql = plans.insertDeadLetterJob(this.config.schema)
    let count = 0

    for (const job of jobs) {
      // Per-job output when supplied (perJobResults), otherwise the single shared output.
      const jobOutput = outputById ? (outputById.get(job.id) ?? null) : outputData

      // CockroachDB returns INT8 columns as strings. These rows come straight from a SELECT *, so
      // unlike fetch/getJobById they are never normalized. Coerce the fields used in arithmetic and
      // comparison below — otherwise `retry_count < retry_limit` is a lexicographic string compare
      // ("9" < "10" === false, wrongly failing a retriable job) and `retry_count + 1` concatenates.
      const retryCount = Number(job.retry_count)
      const retryLimit = Number(job.retry_limit)
      const retryDelay = Number(job.retry_delay)
      const retryDelayMax = job.retry_delay_max != null ? Number(job.retry_delay_max) : null

      // forceTerminal (perJobResults `deadletter`) skips retries so the job fails terminally and
      // routes straight to the dead letter queue below.
      const canRetry = !forceTerminal && retryCount < retryLimit
      let retried = false

      if (canRetry) {
        // Calculate start_after for retry
        let startAfter = job.start_after
        if (!job.retry_backoff) {
          startAfter = new Date(Date.now() + retryDelay * 1000)
        } else {
          const exp = Math.min(16, retryCount + 1)
          const delay = retryDelay * (Math.pow(2, exp) / 2 + Math.pow(2, exp) / 2 * Math.random())
          // Match the canonical failJobs() SQL: LEAST(retry_delay_max, delay) caps the backoff,
          // treating NULL as "no cap" and 0 as a real cap. (`?:` would wrongly treat 0 as no cap.)
          const cappedDelay = retryDelayMax != null ? Math.min(retryDelayMax, delay) : delay
          startAfter = new Date(Date.now() + cappedDelay * 1000)
        }

        // heartbeat_on resets to NULL on re-insert; heartbeat_seconds/blocked/blocking/
        // pending_dependencies are preserved so flows and heartbeat detection survive a retry
        // (matches the non-distributed failJobs() CTE).
        const { rows } = await tx.executeSql(insertSql, [
          job.id, job.name, job.priority, job.data, 'retry', job.retry_limit, job.retry_count,
          job.retry_delay, job.retry_backoff, job.retry_delay_max, startAfter, job.started_on,
          job.singleton_key, job.singleton_on, job.group_id, job.group_tier, job.expire_seconds,
          job.deletion_seconds, job.created_on, null, job.keep_until, job.policy,
          jobOutput, job.dead_letter,
          null, job.heartbeat_seconds, job.blocked, job.blocking, job.pending_dependencies
        ])

        // The retry insert can be dropped by ON CONFLICT when the queue policy (e.g. stately,
        // singleton, key_strict_fifo) already has a non-terminal job. Mirror the failed_jobs
        // fallback of the non-distributed failJobs() CTE in that case.
        retried = rows.length > 0
      }

      if (!retried) {
        await tx.executeSql(insertSql, [
          job.id, job.name, job.priority, job.data, 'failed', job.retry_limit, job.retry_count,
          job.retry_delay, job.retry_backoff, job.retry_delay_max, job.start_after, job.started_on,
          job.singleton_key, job.singleton_on, job.group_id, job.group_tier, job.expire_seconds,
          job.deletion_seconds, job.created_on, new Date(), job.keep_until, job.policy,
          jobOutput, job.dead_letter,
          null, job.heartbeat_seconds, job.blocked, job.blocking, job.pending_dependencies
        ])

        // Insert to dead letter queue if failed and has dead_letter configured
        if (job.dead_letter) {
          await tx.executeSql(dlqSql, [job.dead_letter, job.data, jobOutput])
        }
      }

      count++
    }

    return count
  }

  async deleteJob (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'deleteJob')
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteJobsById(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async cancel (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const { table } = await this.getQueueCache(name)
    const sql = plans.cancelJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async resume (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'resume')
    const { table } = await this.getQueueCache(name)
    const sql = plans.resumeJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async restore (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'restore')
    const { table } = await this.getQueueCache(name)
    const sql = plans.restoreJobs(this.config.schema, table)
    await db.executeSql(sql, [name, ids])
  }

  async retry (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'retry')
    const { table } = await this.getQueueCache(name)
    const sql = plans.retryJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async touch (name: string, id: string | string[], options: types.ConnectionOptions = {}): Promise<types.CommandResponse> {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'touch')
    const { table } = await this.getQueueCache(name)
    const sql = plans.touchJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async createQueue (name: string, options: Omit<types.Queue, 'name'> & { name?: string } = {}) {
    name = name || options.name!

    Attorney.assertQueueName(name)

    const policy = options.policy || plans.QUEUE_POLICIES.standard

    assert(policy in plans.QUEUE_POLICIES, `${policy} is not a valid queue policy`)

    Attorney.validateQueueArgs(options)

    if (options.deadLetter) {
      Attorney.assertQueueName(options.deadLetter)
      notStrictEqual(name, options.deadLetter, 'deadLetter cannot be itself')
      await this.getQueueCache(options.deadLetter)
    }

    const sql = plans.createQueue(this.config.schema, name, { ...options, policy }, this.config.noAdvisoryLocks)
    await this.db.executeSql(sql)
  }

  async getBlockedKeys (name: string): Promise<string[]> {
    Attorney.assertQueueName(name)

    const { table, policy } = await this.getQueueCache(name)

    if (policy !== plans.QUEUE_POLICIES.key_strict_fifo) {
      throw new Error(`getBlockedKeys is only available for ${plans.QUEUE_POLICIES.key_strict_fifo} queues`)
    }

    const sql = plans.getBlockedKeys(this.config.schema, table)
    const { rows } = await this.db.executeSql(sql, [name])

    return rows.map(row => row.singletonKey)
  }

  async getQueues (names?: string | string[]): Promise<types.QueueResult[]> {
    names = Array.isArray(names) ? names : typeof names === 'string' ? [names] : undefined
    if (names) {
      for (const name of names) {
        Attorney.assertQueueName(name)
      }
    }

    const query = plans.getQueues(this.config.schema, names)
    const { rows } = await this.db.executeSql(query.text, query.values)

    // CockroachDB returns integer columns as strings; normalize the numeric queue fields.
    if (this.config.backend === 'cockroachdb') {
      for (const row of rows) {
        for (const field of NUMERIC_QUEUE_FIELDS) {
          if (row[field] !== undefined && row[field] !== null) row[field] = Number(row[field])
        }
      }
    }

    return rows
  }

  async updateQueue (name: string, options: types.UpdateQueueOptions = {}) {
    Attorney.assertQueueName(name)

    assert(Object.keys(options).length > 0, 'no properties found to update')

    if ('policy' in options) {
      throw new Error('queue policy cannot be changed after creation')
    }

    if ('partition' in options) {
      throw new Error('queue partitioning cannot be changed after creation')
    }

    Attorney.validateQueueArgs(options)

    const { deadLetter } = options

    if (deadLetter) {
      Attorney.assertQueueName(deadLetter)
      notStrictEqual(name, deadLetter, 'deadLetter cannot be itself')
    }

    const sql = plans.updateQueue(this.config.schema, { deadLetter })
    await this.db.executeSql(sql, [name, options])
  }

  async getQueue (name: string) {
    const rows = await this.getQueues([name])

    return rows[0] || null
  }

  async deleteQueue (name: string) {
    Attorney.assertQueueName(name)

    try {
      await this.getQueueCache(name)
      const sql = plans.deleteQueue(this.config.schema, name, this.config.noAdvisoryLocks)
      await this.db.executeSql(sql)
    } catch { }
  }

  async deleteQueuedJobs (name: string) {
    Attorney.assertQueueName(name)
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteQueuedJobs(this.config.schema, table)
    await this.db.executeSql(sql, [name])
  }

  async deleteStoredJobs (name: string) {
    Attorney.assertQueueName(name)
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteStoredJobs(this.config.schema, table)
    await this.db.executeSql(sql, [name])
  }

  async deleteAllJobs (name?: string) {
    if (!name) {
      const sql = plans.truncateTable(this.config.schema, 'job')
      await this.db.executeSql(sql)
      return
    }

    Attorney.assertQueueName(name)
    const { table, partition } = await this.getQueueCache(name)

    if (partition) {
      const sql = plans.truncateTable(this.config.schema, table)
      await this.db.executeSql(sql)
    } else {
      const sql = plans.deleteAllJobs(this.config.schema, table)
      await this.db.executeSql(sql, [name])
    }
  }

  async getQueueStats (name: string) {
    Attorney.assertQueueName(name)

    const queue = await this.getQueueCache(name)

    const query = plans.getQueueStats(this.config.schema, queue.table, [name])

    const { rows } = await this.db.executeSql(query.text, query.values)

    const stats = rows.at(0)

    // CockroachDB returns integer columns as strings; normalize the stats counts. (The queue fields
    // merged in below come from getQueueCache -> getQueues, which already normalizes them.)
    if (stats && this.config.backend === 'cockroachdb') {
      for (const field of NUMERIC_QUEUE_FIELDS) {
        if (stats[field] !== undefined && stats[field] !== null) stats[field] = Number(stats[field])
      }
    }

    return Object.assign(queue, stats ||
            {
              deferredCount: 0,
              queuedCount: 0,
              readyCount: 0,
              activeCount: 0,
              failedCount: 0,
              totalCount: 0
            }
    )
  }

  async getJobById<T>(name: string, id: string, options: types.ConnectionOptions = {}): Promise<types.JobWithMetadata<T> | null> {
    Attorney.assertQueueName(name)

    const db = this.assertDb(options)

    const { table } = await this.getQueueCache(name)

    const sql = plans.getJobById(this.config.schema, table)

    const result1 = await db.executeSql(sql, [name, id])

    if (result1?.rows?.length === 1) {
      const row = result1.rows[0]

      // CockroachDB returns integer columns as strings; normalize the numeric
      // metadata fields so callers get numbers regardless of the backend.
      if (this.config.backend === 'cockroachdb') {
        for (const field of NUMERIC_METADATA_FIELDS) {
          if (row[field] !== undefined && row[field] !== null) row[field] = Number(row[field])
        }
      }

      return row
    } else {
      return null
    }
  }

  async findJobs<T>(name: string, options: types.FindJobsOptions = {}): Promise<types.JobWithMetadata<T>[]> {
    Attorney.assertQueueName(name)

    const db = this.assertDb(options)

    const { table } = await this.getQueueCache(name)

    const { id, key, data, queued = false } = options

    const sql = plans.findJobs(this.config.schema, table, {
      byId: id !== undefined,
      byKey: key !== undefined,
      byData: data !== undefined,
      queued
    })

    const values: unknown[] = [name]
    if (id !== undefined) values.push(id)
    if (key !== undefined) values.push(key)
    if (data !== undefined) values.push(JSON.stringify(data))

    const result = await db.executeSql(sql, values)

    return result?.rows || []
  }

  async getDependencies (name: string, id: string, options: types.ConnectionOptions = {}): Promise<types.DependencyRef[]> {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const sql = plans.getDependencies(this.config.schema)
    const { rows } = await db.executeSql(sql, [name, id])
    return rows.map((r: any) => ({ name: r.parentName, id: r.parentId }))
  }

  async getDependents (name: string, id: string, options: types.ConnectionOptions = {}): Promise<types.DependencyRef[]> {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const sql = plans.getDependents(this.config.schema)
    const { rows } = await db.executeSql(sql, [name, id])
    return rows.map((r: any) => ({ name: r.childName, id: r.childId }))
  }

  private assertDb (options: types.ConnectionOptions) {
    if (options.db) {
      return options.db
    }

    if (this.db._pgbdb) {
      assert(this.db.opened, 'Database connection is not opened')
    }

    return this.db
  }
}

export default Manager
