import assert, { notStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import { serializeError as stringify } from './serialize-error.ts'
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

// The sqlite dialect stores timestamps as ISO text, booleans as 0/1, and json/arrays as TEXT;
// re-hydrate the JS types the pg driver returns natively so row shapes match across backends.
const QUEUE_BOOL_FIELDS = ['retryBackoff', 'partition', 'notify'] as const
const QUEUE_DATE_FIELDS = ['createdOn', 'updatedOn'] as const

const JOB_DATE_FIELDS = ['startAfter', 'startedOn', 'singletonOn', 'heartbeatOn', 'createdOn', 'completedOn', 'keepUntil', 'sourceCreatedOn'] as const
const JOB_BOOL_FIELDS = ['retryBackoff', 'blocked', 'blocking'] as const

function coerceSqliteJobRow (row: any): any {
  if (typeof row.data === 'string') row.data = JSON.parse(row.data)
  if (typeof row.output === 'string') row.output = JSON.parse(row.output)
  for (const field of JOB_BOOL_FIELDS) {
    if (row[field] !== undefined && row[field] !== null) row[field] = !!row[field]
  }
  for (const field of JOB_DATE_FIELDS) {
    if (typeof row[field] === 'string') row[field] = new Date(row[field])
  }
  return row
}

function coerceSqliteQueueRow (row: any): any {
  for (const field of QUEUE_BOOL_FIELDS) {
    if (row[field] !== undefined && row[field] !== null) row[field] = !!row[field]
  }
  for (const field of QUEUE_DATE_FIELDS) {
    if (typeof row[field] === 'string') row[field] = new Date(row[field])
  }
  if (typeof row.singletonsActive === 'string') row.singletonsActive = JSON.parse(row.singletonsActive)
  return row
}

// The count columns shared by live stats and recorded snapshots (the QueueStats shape).
const STATS_COUNT_FIELDS = [
  'deferredCount',
  'queuedCount',
  'readyCount',
  'activeCount',
  'failedCount',
  'totalCount'
] as const

// Stale-cache budget for getQueueStats. A queue-table cache older than
// this means monitoring isn't keeping it current (e.g. supervise was enabled once but isn't now), so
// the counts are recomputed and re-cached instead of returned. Defaults to one hour, raised to the
// configured monitor/supervise interval when that's larger (both capped at MAX_EXPIRATION_HOURS).
const QUEUE_STATS_CACHE_TTL_SECONDS = 60 * 60

// Tighter budget applied when getQueueStats is called with { force: true }: recompute for a fresh
// reading, but still reuse anything computed within the last minute so back-to-back forced calls
// don't each re-run the job-table aggregate.
const QUEUE_STATS_FORCE_TTL_SECONDS = 60

const events = {
  error: 'error',
  wip: 'wip'
}

// The error event contract is an Error instance, so listeners can rely on instanceof and .name.
function asError (value: any): Error {
  return value instanceof Error ? value : Object.assign(new Error(value?.message ?? String(value)), value)
}

// Standard translation of low-level Postgres errors raised by job-creation SQL
// into actionable bun-boss errors. Centralized so any write path can reuse it.
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
  #lastRefreshEmpty = false

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    super()

    this.config = config
    this.db = db
    this.wipTs = Date.now()
    this.workers = new Map()
    this.queues = {}
    this.pendingOffWorkCleanups = new Set()
    this.#spies = new Map()
  }

  getSpy<T = object> (name: string): JobSpyInterface<T> {
    if (!this.config.__test__enableSpies) {
      throw new Error('Spy is not enabled. Set __test__enableSpies: true in constructor options to use spies.')
    }
    return this.#spyFor(name)! as unknown as JobSpyInterface<T>
  }

  // Every record site goes through this lazy accessor rather than #spies.get, so transitions that
  // happen before the first getSpy() call for a queue are still captured — the testing docs promise
  // waitForJob resolves immediately for jobs that reached the state before the spy was fetched.
  #spyFor (name: string): JobSpy | undefined {
    if (!this.config.__test__enableSpies) {
      return undefined
    }
    let spy = this.#spies.get(name)
    if (!spy) {
      spy = new JobSpy()
      this.#spies.set(name, spy)
    }
    return spy
  }

  clearSpies (): void {
    for (const spy of this.#spies.values()) {
      spy.clear()
    }
    this.#spies.clear()
  }

  #trackJobsActive<T> (name: string, jobs: types.Job<T>[]): void {
    const spy = this.#spyFor(name)
    if (spy) {
      for (const job of jobs) {
        spy.addJob(job.id, name, job.data as object, 'active')
      }
    }
  }

  async #trackJobsCompleted<T> (name: string, jobs: types.Job<T>[], result: unknown, affected: number): Promise<void> {
    const spy = this.#spyFor(name)
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
    const spy = this.#spyFor(name)
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
    const spy = this.#spyFor(name)
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
  async #settlePerJob<T> (name: string, jobs: types.Job<T>[], result: unknown): Promise<number> {
    if (!Array.isArray(result)) {
      // The handler opted into perJobResults but did not return an array: a contract violation.
      // Fail the whole batch so the mistake surfaces and the jobs are retried.
      const err = new Error('perJobResults handler must resolve with an array of job results')
      await this.fail(name, jobs.map(job => job.id), err)
      await this.#trackJobsFailed(name, jobs, err)
      return 0
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

    return completed.length
  }

  // Complete a set of active jobs, each with its own output, in a constant number of statements
  // (one normally, two under noMultiMutationCte). Outputs are serialized like complete()/fail()
  // and passed as a JSON recordset so the batch size doesn't drive the statement count.
  async #completeWithOutputs (name: string, items: { id: string, output: unknown }[]): Promise<types.CommandResponse> {
    const { table } = await this.getQueueCache(name)
    const payload = items.map(item => ({ id: item.id, output: this.mapCompletionDataArg(item.output) }))
    const ids = items.map(item => item.id)

    if (this.config.noMultiMutationCte) {
      // Dependency unblocking is handled out of band by the background resolver (Navigator), so
      // completion is a single statement here too.
      const sql = plans.completeJobsWithOutputsNoCte(this.config, table)
      const { rows } = await this.db.executeSql(sql, [name, JSON.stringify(payload)])
      return { jobs: ids, requested: ids.length, affected: rows.length }
    }

    const sql = plans.completeJobsWithOutputs(this.config, table)
    const result = await this.db.executeSql(sql, [name, JSON.stringify(payload)])
    return this.mapCommandResponse(ids, result)
  }

  // Fail a set of active jobs, each with its own output, in a constant number of statements. Under
  // noMultiMutationCte this reuses the select -> delete -> reinsert split, passing per-id outputs
  // to reinsertFailedJobs so each job keeps its own failure detail. When `forceTerminal` is set the
  // jobs fail terminally and route straight to the dead letter queue, bypassing remaining retries.
  async #failWithOutputs (name: string, items: { id: string, output: unknown }[], forceTerminal = false): Promise<types.CommandResponse> {
    const { table } = await this.getQueueCache(name)
    const ids = items.map(item => item.id)

    if (this.config.noMultiMutationCte) {
      const outputById = new Map(items.map(item => [item.id, this.mapCompletionDataArg(item.output)]))
      return this.ensureTransaction(this.db, async (tx) => {
        const selectQuery = plans.selectJobsToFailById(this.config, table)
        const { rows: jobs } = await tx.executeSql(selectQuery.text, [name, ids])

        if (jobs.length === 0) {
          return { jobs: ids, requested: ids.length, affected: 0 }
        }

        const deleteQuery = plans.deleteJobsToFail(this.config, table)
        await tx.executeSql(deleteQuery.text, [name, ids])

        const count = await this.reinsertFailedJobs(tx, table, jobs, null, outputById, forceTerminal)
        return { jobs: ids, requested: ids.length, affected: count }
      })
    }

    const payload = items.map(item => ({ id: item.id, output: this.mapCompletionDataArg(item.output) }))
    const sql = forceTerminal
      ? plans.deadLetterJobsByIdWithOutputs(this.config, table)
      : plans.failJobsByIdWithOutputs(this.config, table)
    const result = await this.db.executeSql(sql, [name, JSON.stringify(payload)])
    return this.mapCommandResponse(ids, result)
  }

  async #processJobs<T> (
    name: string,
    jobs: types.Job<T>[],
    callback: types.WorkHandler<T>,
    worker?: Worker<T>,
    heartbeatRefreshSeconds?: number,
    perJobResults = false
  ): Promise<number> {
    const jobIds = jobs.map(job => job.id)
    const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expireInSeconds), 0)
    // Minimum, not maximum: heartbeatSeconds is per-job, and failJobsByHeartbeat fails a job once
    // its OWN heartbeat_on is stale by ITS OWN heartbeat_seconds. A refresh cadence derived from
    // the batch max would let a small-heartbeat job in a mixed batch go stale and get failed out
    // from under a still-running handler before the shared timer ever touches it.
    const heartbeatCandidates = jobs.map(j => j.heartbeatSeconds || 0).filter(s => s > 0)
    const heartbeatSeconds = heartbeatCandidates.length ? Math.min(...heartbeatCandidates) : 0
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
    let settledCount = 0

    try {
      const result = await resolveWithinSeconds(callback(jobs), maxExpiration, `handler execution exceeded ${maxExpiration}s`, ac)
      if (perJobResults) {
        // #settlePerJob settles each job individually and does its own (synchronous,
        // lookup-free) spy tracking via #trackJobsSettled, so the deferred tracker below
        // is skipped for this path.
        settledCount = await this.#settlePerJob(name, jobs, result)
      } else {
        const completion = await this.complete(name, jobIds, jobIds.length === 1 ? result : undefined)
        completedResult = result
        completedAffected = completion.affected
        settledCount = jobs.length
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
    if (this.config.__test__enableSpies) {
      if (didFail) {
        await this.#trackJobsFailed(name, jobs, failedError)
      } else if (!perJobResults) {
        // perJobResults already tracked inside #settlePerJob; tracking again here would
        // double-record (and overwrite per-job outputs with the batch's slow-path lookup).
        await this.#trackJobsCompleted(name, jobs, completedResult, completedAffected)
      }
    }

    return settledCount
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

      // One empty snapshot against a non-empty cache is not proof the queues are gone (a driver
      // fault can yield a wrong-empty result set): keep the cache and require the next refresh
      // to confirm before wiping.
      if (queues.length === 0 && !this.#lastRefreshEmpty && this.queues && Object.keys(this.queues).length) {
        this.#lastRefreshEmpty = true
        return
      }

      this.#lastRefreshEmpty = queues.length === 0
      this.queues = queues.reduce<Record<string, types.QueueResult>>((acc, i) => { acc[i.name] = i; return acc }, {})
    } catch (error: any) {
      emit && this.emit(events.error, asError(error))
    }
  }

  async getQueueCache (name: string): Promise<types.QueueResult> {
    assert(this.queues, 'Queue cache is not initialized')

    let queue: types.QueueResult | null | undefined = this.queues[name]

    if (queue) {
      return queue
    }

    // Corroborate a negative before concluding nonexistence: a transient driver fault can
    // return a wrong-empty result set, and a single uncorroborated empty read must not become
    // a user-visible failure. Positive results are never re-read.
    queue = await this.getQueue(name) ?? await this.getQueue(name)

    if (!queue) {
      throw new Error(`Queue ${name} does not exist`)
    }

    this.#cacheQueueRow(name, queue)

    return queue
  }

  #evictQueueCache (name: string) {
    if (this.queues) delete this.queues[name]
  }

  #cacheQueueRow (name: string, queue: types.QueueResult) {
    this.queues![name] = queue
    // A live row is proof the queue table is non-empty: re-arm the guard that keeps a single
    // empty refresh from wiping the cache.
    this.#lastRefreshEmpty = false
  }

  // Read-back, not synthesis: createQueue on an existing queue is a config-preserving no-op
  // (ON CONFLICT DO NOTHING), so the DB row is the only truth worth caching. An empty read-back
  // (transient driver fault) degrades to the old behavior — evict and let getQueueCache refill.
  async #refreshQueueCacheEntry (name: string) {
    const queue = await this.getQueue(name)
    if (queue) this.#cacheQueueRow(name, queue)
    else this.#evictQueueCache(name)
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
  }

  async failWip () {
    for (const worker of this.workers.values()) {
      const jobIds = worker.jobs.map(j => j.id)
      if (jobIds.length) {
        await this.fail(worker.name, jobIds, 'bun-boss shut down while active')
      }
      worker.abort()
    }
  }

  work<ReqData>(name: string, handler: types.WorkHandler<ReqData>): Promise<string>
  work<ReqData, const O extends types.WorkOptions = types.WorkOptions>(name: string, options: O, handler: types.WorkHandlerFor<O, ReqData>): Promise<string>
  async work<ReqData> (name: string, ...args: unknown[]): Promise<string> {
    const { options, callback } = Attorney.checkWorkArgs(name, args)

    if (this.stopped) {
      throw new Error('Workers are disabled. bun-boss is stopped')
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
      groupConcurrency,
      orderByCreatedOn = true,
      ignoreStartAfter = false,
      heartbeatRefreshSeconds,
      minPriority,
      maxPriority,
      perJobResults = false,
    } = options

    // On by default, but not for a caller who configured one of the fullBatch-gated triggers:
    // those exist to hold burst mode back, and silently widening them to any non-empty fetch
    // would change a deliberately tuned setup on upgrade.
    const burstWhileNonEmpty = options.burstWhileNonEmpty ?? (burstWhenReadyExceeds === undefined && !burstWhenBatchFull)

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
    // burstWhileNonEmpty (default on) bursts while jobs keep settling, so a backlog drains at the
    // fetch rate rather than one job per poll interval even at batchSize 1. It gates on settled
    // rather than fetched jobs because retryDelay defaults to 0: a batch whose handler threw is
    // instantly re-fetchable, and bursting on it would burn every retryLimit attempt in
    // milliseconds. The fullBatch-gated triggers stay for opt-out (burstWhileNonEmpty: false): a
    // short fetch means the queue likely caught up, and burstWhenBatchFull is ignored at batchSize
    // 1 (every fetch would be "full").
    const resolveInterval = (fetchedCount: number, settledCount: number) => {
      const fullBatch = fetchedCount >= batchSize
      const burst =
        (burstWhileNonEmpty && settledCount > 0) ||
        (fullBatch && (
          (burstWhenReadyExceeds !== undefined && getReadyCount() > burstWhenReadyExceeds) ||
          (burstWhenBatchFull && batchSize > 1)
        ))

      if (burst) return 0
      return isNotifyActive() ? notifyInterval : interval
    }

    const createWorker = (workerId: string, workId: string) => {
      const fetch = () => {
        return this.fetch<ReqData>(name, { batchSize, includeMetadata, priority, orderByCreatedOn, ignoreStartAfter, groupConcurrency, minPriority, maxPriority })
      }

      const onFetch = async (jobs: types.Job<ReqData>[]) => {
        if (!jobs.length) return 0
        if (this.config.__test__throw_worker) throw new Error('__test__throw_worker')

        this.emitWip(name)
        this.#trackJobsActive(name, jobs)

        // Get the worker instance for abort controller tracking
        const worker = this.workers.get(workerId)

        const settledCount = await this.#processJobs(name, jobs, callback, worker, heartbeatRefreshSeconds, perJobResults)

        this.emitWip(name)

        return settledCount
      }

      const onError = (error: any) => {
        this.emit(events.error, Object.assign(asError(error), { queue: name, worker: workerId }))
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

    // work() returns only the first spawned worker's id (shared as `workId` across every worker
    // it spawned under localConcurrency), so { id } must match on workId too — otherwise only
    // worker 0 of a localConcurrency > 1 call ever stops, and the rest poll forever with no other
    // way to reach them. i.id is still checked so a specific worker id from getWipData() still
    // targets just that one worker. name is always required so a stray/mismatched id can't stop
    // a worker on a different queue.
    const query = (i: Worker<any>) => i.name === name && (options?.id ? (i.id === options.id || i.workId === options.id) : true)

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
    } else {
      this.pendingOffWorkCleanups.add(cleanupPromise)
      cleanupPromise.finally(() => {
        this.pendingOffWorkCleanups.delete(cleanupPromise)
      })
    }
  }

  notifyWorker (workerId: string): void {
    this.workers.get(workerId)?.notify()
  }

  // Whether a queue's `notify` opt-in actually emits a transactional pg_notify. Backends that
  // don't implement LISTEN/NOTIFY (noListenNotify, e.g. SQLite) would error on the inlined
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

  // The sqlite dialect has no interval type, so relative startAfter strings that Postgres
  // resolves via CAST(text AS interval) are converted to numeric seconds here. Absolute
  // ISO ('Z'-suffixed) and numeric values pass through to SQL untouched.
  #normalizeStartAfter<T extends { startAfter?: unknown }> (payload: T): T {
    const value = payload.startAfter

    if (this.config.dialect?.name === 'sqlite' &&
      typeof value === 'string' && !value.endsWith('Z') && !/^-?\d+(\.\d+)?$/.test(value)) {
      payload.startAfter = String(Attorney.parseIntervalSeconds(value)) as T['startAfter']
    }

    return payload
  }

  // Shapes a validated request into the JSON job payload consumed by plans.insertJobs and
  // plans.updateJob. Shared by createJob (send) and update/upsert so all three derive
  // start_after/keep_until/singleton the same way.
  #toJobPayload (name: string, data: object | null, options: types.SendOptions) {
    const {
      id = null,
      priority,
      startAfter,
      singletonKey = null,
      singletonSeconds,
      expireInSeconds,
      deleteAfterSeconds,
      retentionSeconds,
      retryLimit,
      retryDelay,
      retryBackoff,
      retryDelayMax,
      heartbeatSeconds,
      group,
      deadLetter = null
    } = options

    return this.#normalizeStartAfter({
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
      retryLimit,
      retryDelay,
      retryBackoff,
      retryDelayMax,
      heartbeatSeconds,
      deadLetter
    })
  }

  async createJob (request: types.Request): Promise<string | null> {
    const { name, data = null, options = {} } = request
    const { db: wrapper, singletonSeconds, singletonNextSlot } = options

    const job = this.#toJobPayload(name, data, options)

    const db = wrapper || this.db

    const { table, notify } = await this.getQueueCache(name)

    const sql = plans.insertJobs(this.config, { table, name, returnId: true, notify: this.#notifyEnabled(notify) })

    const { rows: try1 } = await db.executeSql(sql, [JSON.stringify([job])])

    if (try1.length === 1) {
      const jobId = try1[0].id
      this.#spyFor(name)?.addJob(jobId, name, data || {}, 'created')
      return jobId
    }

    if (singletonNextSlot) {
      // delay starting by the offset to honor throttling config
      job.startAfter = this.getDebounceStartAfter(singletonSeconds!, this.timekeeper!.clockSkew)
      job.singletonOffset = singletonSeconds

      const { rows: try2 } = await db.executeSql(sql, [JSON.stringify([job])])

      if (try2.length === 1) {
        const jobId = try2[0].id
        this.#spyFor(name)?.addJob(jobId, name, data || {}, 'created')
        return jobId
      }
    }

    return null
  }

  // Builds the partial-edit payload for update()/upsert(): ONLY the fields the caller actually
  // supplied end up as keys (undefined is dropped by JSON.stringify), so plans.updateJob leaves
  // every other column untouched. Compatible with both plans.updateJob ($1 = this object) and
  // plans.insertJobs ($1 = [this object]), whose json_to_recordset treats absent keys as null.
  #toUpdatePayload (data: object | null | undefined, options: types.UpdateOptions) {
    return this.#normalizeStartAfter({
      data,
      priority: options.priority,
      startAfter: options.startAfter,
      retentionSeconds: options.retentionSeconds,
      expireInSeconds: options.expireInSeconds,
      deleteAfterSeconds: options.deleteAfterSeconds,
      retryLimit: options.retryLimit,
      retryDelay: options.retryDelay,
      retryBackoff: options.retryBackoff,
      retryDelayMax: options.retryDelayMax,
      deadLetter: options.deadLetter,
      heartbeatSeconds: options.heartbeatSeconds,
      groupId: options.group?.id,
      groupTier: options.group?.tier,
      id: options.id,
      singletonKey: options.singletonKey
    })
  }

  // Edits the mutable fields of not-yet-active (created/retry) jobs in place, preserving their
  // id/state/singleton identity. Only the fields present in `options` (plus `data` when supplied)
  // are changed; everything else is left as-is. Targets by id or singletonKey; never inserts.
  // Returns the ids that were updated ([] when nothing matched — missing or already active).
  update (request: types.UpdateRequest): Promise<types.UpdateResponse>
  update (name: string, data: object | null | undefined, options?: types.UpdateOptions): Promise<types.UpdateResponse>
  async update (...args: any[]): Promise<types.UpdateResponse> {
    const request = Attorney.checkUpdateArgs(args)
    const { name, data } = request
    const opts = (request.options ?? {}) as types.UpdateOptions

    Attorney.assertQueueName(name)
    const db = this.assertDb(opts)
    const { table, notify } = await this.getQueueCache(name)

    const by = opts.id ? 'id' : 'singletonKey'
    const match = opts.match ?? 'newest'
    const payload = JSON.stringify(this.#toUpdatePayload(data, opts))

    const sql = plans.updateJob(this.config, table, name, by, match, this.#notifyEnabled(notify))
    const { rows } = await db.executeSql(sql, [payload])

    const jobs = rows.map(row => row.id)
    return { jobs, updated: jobs.length }
  }

  // update-or-insert by id or singletonKey: edit the matching pre-active job(s) in place,
  // otherwise insert a fresh job. Runs update-first (policy-independent match), inserting only
  // when nothing matched; a deduped insert (lost the race to a concurrent writer, or an id that
  // collides with an existing non-pre-active job) falls back to one more update. See docs for
  // the ordering rationale.
  upsert (request: types.UpdateRequest): Promise<types.UpsertResponse>
  upsert (name: string, data: object | null | undefined, options?: types.UpdateOptions): Promise<types.UpsertResponse>
  async upsert (...args: any[]): Promise<types.UpsertResponse> {
    const request = Attorney.checkUpdateArgs(args, { upsert: true })
    const { name, data } = request
    const opts = (request.options ?? {}) as types.UpdateOptions

    Attorney.assertQueueName(name)
    const db = this.assertDb(opts)
    const { table, notify } = await this.getQueueCache(name)

    const by = opts.id ? 'id' : 'singletonKey'
    const match = opts.match ?? 'newest'

    const notifyEnabled = this.#notifyEnabled(notify)
    const updateSql = plans.updateJob(this.config, table, name, by, match, notifyEnabled)
    const insertSql = plans.insertJobs(this.config, { table, name, returnId: true, notify: notifyEnabled })

    const job = this.#toUpdatePayload(data, opts)
    const updatePayload = JSON.stringify(job)
    const insertPayload = JSON.stringify([job])

    const result = await this.ensureTransaction(db, async (tx) => {
      const { rows: updated } = await tx.executeSql(updateSql, [updatePayload])
      if (updated.length) {
        const jobs = updated.map(row => row.id)
        return { jobs, updated: jobs.length, inserted: 0 }
      }

      const { rows: inserted } = await tx.executeSql(insertSql, [insertPayload])
      if (inserted.length) {
        const jobs = inserted.map(row => row.id)
        return { jobs, updated: 0, inserted: jobs.length }
      }

      // The insert was skipped by ON CONFLICT (a concurrent send/upsert won the race); the
      // conflicting row is now visible, so edit it.
      const { rows: retry } = await tx.executeSql(updateSql, [updatePayload])
      const jobs = retry.map(row => row.id)
      return { jobs, updated: jobs.length, inserted: 0 }
    })

    // Track inserted (newly created) jobs for spies, matching createJob/insert. Runs after the
    // transaction commits so a rolled-back insert never leaves a phantom spy entry.
    if (result.inserted) {
      const spy = this.#spyFor(name)
      if (spy) {
        for (const id of result.jobs) {
          spy.addJob(id, name, data || {}, 'created')
        }
      }
    }

    return result
  }

  async insert (
    name: string,
    jobs: types.JobInsert[],
    options: types.InsertOptions = {}
  ) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const seenIds = new Set<string>()
    for (const job of jobs) {
      if (job.id != null) {
        if (seenIds.has(job.id)) {
          throw new Error(`duplicate job id in insert batch: ${job.id}`)
        }
        seenIds.add(job.id)
      }

      // insert() otherwise skips Attorney on purpose (it is the raw, high-volume path), but an
      // invalid group is worth rejecting here: send() already throws on it, and an empty-string
      // group.id would silently become a real concurrency group named '' once persisted.
      Attorney.validateGroupConfig(job)
    }

    const { table, notify } = await this.getQueueCache(name)

    const spy = this.#spyFor(name)

    // insertJobs ends in ON CONFLICT DO NOTHING, so skipped rows shift the returned rows out of
    // alignment with the input jobs — a positional rows[i] <-> jobs[i] pairing attributes the wrong
    // data to the wrong id. When a spy is watching, assign every job an explicit id up front (the
    // insert COALESCEs id, so this is equivalent to letting the DB generate one) and index data by
    // id, so returned rows can be matched back to their job regardless of any conflicts.
    const dataById = spy ? new Map<string, unknown>() : undefined

    const insertPayload = jobs.map(j => {
      const {
        blocked,
        blocking,
        pendingDependencies,
        group,
        ...rest
      } = j as types.JobInsert & { blocked?: unknown, blocking?: unknown, pendingDependencies?: unknown }

      // Flatten group to the column names insertJobs' json_to_recordset declares, matching
      // send()/upsert()/flow(). Assigned only when a group is present: those same raw column
      // names are accepted by the recordset directly, and unconditional keys would overwrite
      // them with undefined — silently breaking anyone who passed groupId/groupTier as a
      // workaround while insert() was dropping `group` entirely.
      if (group) {
        Object.assign(rest, { groupId: group.id, groupTier: group.tier })
      }

      this.#normalizeStartAfter(rest as { startAfter?: unknown })

      if (dataById) {
        // Best-effort spy bookkeeping, only reached when __test__enableSpies is set (a test-intended
        // opt-in, off by default). The id we assign here is exactly what the DB would otherwise
        // COALESCE in, so generating it client-side is harmless — and if randomUUID ever fell short,
        // only spy attribution would degrade, never the insert itself.
        rest.id ??= randomUUID()
        dataById.set(rest.id, j.data ?? {})
      }

      return rest
    })

    const db = this.assertDb(options)

    // Return IDs if spy is active for this queue (needed for job tracking)
    const returnId = !!spy || !!options.returnId

    const sql = plans.insertJobs(this.config, { table, name, returnId, notify: this.#notifyEnabled(notify) })

    const { rows } = await db.executeSql(sql, [JSON.stringify(insertPayload)])

    if (rows.length) {
      if (spy) {
        // dataById is populated for every job when a spy is active
        for (const row of rows) {
          spy.addJob(row.id, name, dataById!.get(row.id) as object, 'created')
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
          child_id: refToId[job.ref]!,
          parent_name: parentJob.name,
          parent_id: refToId[depRef]!
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

    // sqlite path: parameterized per-queue inserts collected for a JS-verified transaction
    // below (embedded JSON literals and the division-by-zero guard don't exist there).
    const sqliteInserts: Array<{ queueName: string, table: string, payload: unknown[] }> = []
    const isSqliteDialect = this.config.dialect?.name === 'sqlite'

    for (const [queueName, queueJobs] of byQueue) {
      const { table, notify } = await this.getQueueCache(queueName)

      const insertPayload = queueJobs.map(j => {
        const dependencyCount = dependencyCountByRef.get(j.ref) ?? 0
        return this.#normalizeStartAfter({
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
        })
      })

      if (isSqliteDialect) {
        sqliteInserts.push({ queueName, table, payload: insertPayload })
        continue
      }

      statements.push(plans.insertFlowJobs(this.config, { table, name: queueName }, insertPayload))

      // Wake workers for notify-enabled queues. Runs in the same transaction as the
      // inserts above, so it commits atomically. Blocked children and future-dated roots
      // are harmless: the fetch query filters them out, so a wake just triggers one fetch
      // that picks up whatever roots are immediately runnable.
      if (this.#notifyEnabled(notify)) {
        statements.push(plans.notifyQueue(this.config, queueName))
      }
    }

    // sqlite: bound-parameter inserts inside a real transaction, with the all-or-nothing
    // guard enforced in JS — SQLite returns NULL for the division-by-zero trick, so a
    // partial flow must be detected by comparing inserted row counts instead.
    if (isSqliteDialect) {
      const runFlow = async (tx: types.IDatabase) => {
        for (const { queueName, table, payload } of sqliteInserts) {
          const sql = plans.insertJobs(this.config, { table, name: queueName, returnId: true })
          const { rows } = await tx.executeSql(sql, [JSON.stringify(payload)])

          if (rows.length !== payload.length) {
            // The same signal the postgres guard raises, so rethrowWriteError translates it
            // into the identical user-facing error (and the transaction rolls back).
            throw Object.assign(new Error('flow insert skipped by a queue policy conflict'), { code: plans.PG_ERROR.divisionByZero })
          }
        }

        if (depRows.length > 0) {
          await tx.executeSql(plans.insertDependencies(this.config), [JSON.stringify(depRows)])
        }
      }

      try {
        // A caller-supplied db owns its transaction; statements compose inline there.
        if (options.db) {
          await runFlow(options.db)
        } else {
          await this.ensureTransaction(this.db, runFlow)
        }
      } catch (err) {
        rethrowWriteError(err)
      }

      return refToId
    }

    if (depRows.length > 0) {
      statements.push(plans.insertDependencies(this.config, depRows))
    }

    // When the caller provides a db they own the transaction; otherwise wrap the
    // statements so they run atomically as a single round-trip on any adapter.
    const db = options.db ?? this.db
    const sql = options.db ? statements.join(';\n') : plans.transaction(this.config, statements)

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
      dialect: this.config.dialect,
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
    } catch (err: any) {
      // The only fetch error we tolerate is a unique-constraint violation (SQLSTATE 23505) from a
      // policy/singleton index when a concurrent fetch won the same slot — treat that as an empty
      // fetch. Anything else (a DB outage, a malformed query) must surface: swallowing it turned
      // every failed fetch into a silent [] with no error event, indistinguishable from an empty
      // queue. Rethrowing routes it to the worker's onError (emits `error`) or to a direct caller.
      if (err?.code !== '23505') throw err
    }

    const rows = result?.rows || []

    if (this.config.dialect?.name === 'sqlite') {
      for (const row of rows) coerceSqliteJobRow(row)

      // SQLite's RETURNING order is unspecified; restore the claim ordering the fetch query
      // selected by (ISO text sorts chronologically). The hidden keys exist only when the fetch
      // was minimal — metadata fetches sort by their own priority/createdOn columns.
      const { priority = true, orderByCreatedOn = true } = options
      const sortPriority = (row: any) => row.__priority ?? row.priority ?? 0
      const sortCreatedOn = (row: any) => String(row.__createdOn ?? (row.createdOn instanceof Date ? row.createdOn.toISOString() : row.createdOn) ?? '')

      rows.sort((a: any, b: any) =>
        (priority ? sortPriority(b) - sortPriority(a) : 0) ||
        (orderByCreatedOn ? sortCreatedOn(a).localeCompare(sortCreatedOn(b)) : 0) ||
        String(a.id).localeCompare(String(b.id))
      )

      for (const row of rows) {
        delete row.__priority
        delete row.__createdOn
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

  // Postgres command plans report a single { count } row; dialect variants that end in
  // RETURNING id report one row per affected job, so fall back to the row count.
  private mapCommandResponse (ids: string[], result: { rows: any[] } | null): types.CommandResponse {
    const rows = result?.rows

    return {
      jobs: ids,
      requested: ids.length,
      affected: !rows ? 0 : rows[0]?.count !== undefined ? parseInt(rows[0].count) : rows.length
    }
  }

  async complete (name: string, id: string | string[], data?: object | null, options: types.CompleteOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'complete')
    const { table } = await this.getQueueCache(name)
    const outputData = this.mapCompletionDataArg(data)

    // noMultiMutationCte: split the dependency-unblocking into a separate statement, since
    // completeJobs updates two tables in one CTE (rejected under this flag).
    if (this.config.noMultiMutationCte) {
      return this.completeNoCte(name, ids, outputData, table, db, options.includeQueued)
    }

    const sql = plans.completeJobs(this.config, table, options.includeQueued)
    const result = await db.executeSql(sql, [name, ids, outputData])
    return this.mapCommandResponse(ids, result)
  }

  // The split complete/fail need several statements run atomically. When we own the database
  // and it can open transactions we pin one via withTransaction(); when the caller supplied their
  // own db (options.db) we run the statements inline so they compose inside the caller's
  // transaction rather than issuing a BEGIN/COMMIT that would commit or roll back their outer work.
  private async ensureTransaction<T> (db: types.IDatabase, fn: (tx: types.IDatabase) => Promise<T>): Promise<T> {
    if (db === this.db && typeof db.withTransaction === 'function') {
      return db.withTransaction(fn)
    }

    return fn(db)
  }

  private async completeNoCte (name: string, ids: string[], outputData: any, table: string, db: types.IDatabase, includeQueued?: boolean): Promise<types.CommandResponse> {
    // Dependency unblocking is handled out of band by the background resolver (Navigator), so
    // completion is a single statement on every backend.
    const sql = plans.completeJobsNoCte(this.config, table, includeQueued)
    const { rows } = await db.executeSql(sql, [name, ids, outputData])
    return { jobs: ids, requested: ids.length, affected: rows.length }
  }

  async fail (name: string, id: string | string[], data?: any, options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'fail')
    const { table } = await this.getQueueCache(name)
    const outputData = this.mapCompletionDataArg(data)

    // noMultiMutationCte: use separate queries instead of one multi-mutation CTE. The delete and
    // re-insert run in a single transaction (see ensureTransaction) so the job cannot be lost
    // between the two statements.
    if (this.config.noMultiMutationCte) {
      return this.failNoCte(name, ids, outputData, table, db)
    }

    const sql = plans.failJobsById(this.config, table)
    const result = await db.executeSql(sql, [name, ids, outputData])
    return this.mapCommandResponse(ids, result)
  }

  private async failNoCte (name: string, ids: string[], outputData: any, table: string, db: types.IDatabase): Promise<types.CommandResponse> {
    // Under noMultiMutationCte the multi-mutation CTE isn't available, but transactions are, so the
    // delete + re-insert is split into separate statements run atomically.
    return this.ensureTransaction(db, async (tx) => {
      // Step 1: Select jobs to fail
      const selectQuery = plans.selectJobsToFailById(this.config, table)
      const { rows: jobs } = await tx.executeSql(selectQuery.text, [name, ids])

      if (jobs.length === 0) {
        return { jobs: ids, requested: ids.length, affected: 0 }
      }

      // Step 2: Delete the jobs
      const deleteQuery = plans.deleteJobsToFail(this.config, table)
      await tx.executeSql(deleteQuery.text, [name, ids])

      // Step 3: Re-insert jobs with updated state
      const count = await this.reinsertFailedJobs(tx, table, jobs, outputData)

      return { jobs: ids, requested: ids.length, affected: count }
    })
  }

  // noMultiMutationCte equivalents of the supervisor's failJobsByTimeout/failJobsByHeartbeat
  // maintenance. Those use the multi-mutation failJobs() CTE, so under this flag we select the
  // expired/timed-out jobs, delete them, and re-insert as retry/failed in a single transaction
  // (the same split as failNoCte). Always run on the pooled connection.
  async failJobsByTimeoutNoCte (table: string, queues: string[]): Promise<number> {
    const select = plans.selectJobsToFailByTimeout(this.config, table, queues)
    return this.expireJobsNoCte(table, select, { value: { message: 'job timed out' } })
  }

  async failJobsByHeartbeatNoCte (table: string, queues: string[]): Promise<number> {
    const select = plans.selectJobsToFailByHeartbeat(this.config, table, queues)
    return this.expireJobsNoCte(table, select, { value: { message: 'job heartbeat timeout' } })
  }

  // noMultiMutationCte flow audit for one partition table: lock a batch of completed blocking
  // parents, then decrement their children and clear blocking per parent queue (decrementDependents
  // and clearBlocking are each keyed by a single name). Returns the number of parents resolved so
  // the resolver can loop until a batch drains.
  async resolveFlowJobsNoCte (table: string, names: string[]): Promise<number> {
    const select = plans.selectBlockingParents(this.config, table, names, this.config.noSkipLocked)

    return this.ensureTransaction(this.db, async (tx) => {
      const { rows } = await tx.executeSql(select.text, select.values)

      if (rows.length === 0) {
        return 0
      }

      const idsByName = new Map<string, string[]>()
      for (const row of rows) {
        const list = idsByName.get(row.name) || []
        list.push(row.id)
        idsByName.set(row.name, list)
      }

      const decrementSql = plans.decrementDependents(this.config)
      const clearSql = plans.clearBlocking(this.config)

      for (const [name, ids] of idsByName) {
        await tx.executeSql(decrementSql, [name, ids])
        await tx.executeSql(clearSql, [name, ids])
      }

      return rows.length
    })
  }

  private async expireJobsNoCte (table: string, select: plans.SqlQuery, outputData: any): Promise<number> {
    return this.ensureTransaction(this.db, async (tx) => {
      const { rows: jobs } = await tx.executeSql(select.text, [])

      if (jobs.length === 0) {
        return 0
      }

      const ids = jobs.map(job => job.id)
      const deleteSql = plans.deleteJobsByIds(this.config, table)
      await tx.executeSql(deleteSql.text, [ids])

      return this.reinsertFailedJobs(tx, table, jobs, outputData)
    })
  }

  // Re-insert a set of just-deleted jobs as retry (when retries remain) or failed (+ dead letter),
  // preserving the flow/heartbeat columns. Shared by failNoCte and the noMultiMutationCte
  // maintenance expiry above. Returns the number of jobs processed.
  private async reinsertFailedJobs (tx: types.IDatabase, table: string, jobs: any[], outputData: any, outputById?: Map<string, any>, forceTerminal = false): Promise<number> {
    const insertSql = plans.insertRetryJob(this.config, table)
    const dlqSql = plans.insertDeadLetterJob(this.config)
    let count = 0

    for (const job of jobs) {
      // Per-job output when supplied (perJobResults), otherwise the single shared output.
      const jobOutput = outputById ? (outputById.get(job.id) ?? null) : outputData

      // Some drivers return integer columns as strings. These rows come straight from a SELECT *, so
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
          const delay = Math.max(retryDelay, 1) * (Math.pow(2, exp) / 2 + Math.pow(2, exp) / 2 * Math.random())
          // Match the canonical failJobs() SQL: LEAST(retry_delay_max, delay) caps the backoff,
          // treating NULL as "no cap" and 0 as a real cap. (`?:` would wrongly treat 0 as no cap.)
          const cappedDelay = retryDelayMax != null ? Math.min(retryDelayMax, delay) : delay
          startAfter = new Date(Date.now() + cappedDelay * 1000)
        }

        // heartbeat_on resets to NULL on re-insert; heartbeat_seconds/blocked/blocking/
        // pending_dependencies are preserved so flows and heartbeat detection survive a retry
        // (matches the single-statement failJobs() CTE).
        const { rows } = await tx.executeSql(insertSql, [
          job.id, job.name, job.priority, job.data, 'retry', job.retry_limit, job.retry_count,
          job.retry_delay, job.retry_backoff, job.retry_delay_max, startAfter, job.started_on,
          job.singleton_key, job.singleton_on, job.group_id, job.group_tier, job.expire_seconds,
          job.deletion_seconds, job.created_on, null, job.keep_until, job.policy,
          jobOutput, job.dead_letter,
          null, job.heartbeat_seconds, job.blocked, job.blocking, job.pending_dependencies
        ])

        // The retry insert can be dropped by ON CONFLICT when the queue policy (e.g. stately,
        // singleton) already has a non-terminal job. Mirror the failed_jobs
        // fallback of the single-statement failJobs() CTE in that case.
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
          await tx.executeSql(dlqSql, [job.dead_letter, job.data, jobOutput, job.name, job.id, job.created_on, job.retry_count, job.singleton_key, job.heartbeat_seconds])
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
    const sql = plans.deleteJobsById(this.config, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async redrive (name: string, options: types.RedriveOptions = {}): Promise<number> {
    Attorney.assertQueueName(name)

    const { destination, sourceName, limit = 1000 } = options

    if (destination !== undefined) {
      Attorney.assertQueueName(destination)
    }

    if (sourceName !== undefined) {
      Attorney.assertQueueName(sourceName)
    }

    assert(Number.isInteger(limit) && limit >= 1, 'limit must be an integer >= 1')

    const db = this.assertDb(options)
    const { table } = await this.getQueueCache(name)

    // SQLite can't run redriveJobs' DML-in-CTE pipeline; split it into select/delete/re-insert
    // inside a transaction (same shape as failNoCte).
    if (this.config.dialect?.name === 'sqlite') {
      return this.ensureTransaction(db, async (tx) => {
        const selectSql = plans.selectJobsToRedrive(this.config, table)
        const { rows: candidates } = await tx.executeSql(selectSql.text, [name, destination ?? null, sourceName ?? null, limit])

        if (!candidates.length) {
          return 0
        }

        const deleteSql = plans.deleteJobsByIds(this.config, table)
        await tx.executeSql(deleteSql.text, [candidates.map((j: any) => j.id)])

        const insertSql = plans.insertRedriveJob(this.config)
        let moved = 0

        for (const job of candidates) {
          const { rows } = await tx.executeSql(insertSql, [
            destination ?? job.sourceName, job.data, job.priority, job.singletonKey, job.heartbeatSeconds
          ])
          moved += rows.length
        }

        return moved
      })
    }

    const sql = plans.redriveJobs(this.config, table)
    const result = await db.executeSql(sql, [name, destination ?? null, sourceName ?? null, limit])
    return result.rows[0].moved as number
  }

  async cancel (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const { table } = await this.getQueueCache(name)
    const sql = plans.cancelJobs(this.config, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async resume (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'resume')
    const { table } = await this.getQueueCache(name)
    const sql = plans.resumeJobs(this.config, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async retry (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'retry')
    const { table } = await this.getQueueCache(name)
    const sql = plans.retryJobs(this.config, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async touch (name: string, id: string | string[], options: types.ConnectionOptions = {}): Promise<types.CommandResponse> {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'touch')
    const { table } = await this.getQueueCache(name)
    const sql = plans.touchJobs(this.config, table)
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

    const sql = plans.createQueue(this.config, name, { ...options, policy }, this.config.noAdvisoryLocks)
    await this.db.executeSql(sql)
    await this.#refreshQueueCacheEntry(name)
  }

  async getQueues (names?: string | string[]): Promise<types.QueueResult[]> {
    names = Array.isArray(names) ? names : typeof names === 'string' ? [names] : undefined
    if (names) {
      for (const name of names) {
        Attorney.assertQueueName(name)
      }
    }

    const query = plans.getQueues(this.config, names)
    const { rows } = await this.db.executeSql(query.text, query.values)

    if (this.config.dialect?.name === 'sqlite') {
      for (const row of rows) coerceSqliteQueueRow(row)
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

    const sql = plans.updateQueue(this.config, { deadLetter })
    await this.db.executeSql(sql, [name, options])
    await this.#refreshQueueCacheEntry(name)
  }

  async getQueue (name: string) {
    const rows = await this.getQueues([name])

    return rows[0] || null
  }

  async deleteQueue (name: string) {
    Attorney.assertQueueName(name)

    // Scope the catch to the cache lookup only: a queue that doesn't exist is a no-op. The DELETE
    // and cache eviction must NOT be swallowed — a transient connection error there previously
    // resolved as success while the queue (and its stale cache entry) survived.
    try {
      await this.getQueueCache(name)
    } catch {
      return
    }

    const sql = plans.deleteQueue(this.config, name, this.config.noAdvisoryLocks)
    await this.db.executeSql(sql)
    this.#evictQueueCache(name)
  }

  async deleteQueuedJobs (name: string) {
    Attorney.assertQueueName(name)
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteQueuedJobs(this.config, table)
    await this.db.executeSql(sql, [name])
  }

  async deleteStoredJobs (name: string) {
    Attorney.assertQueueName(name)
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteStoredJobs(this.config, table)
    await this.db.executeSql(sql, [name])
  }

  async deleteAllJobs (name?: string) {
    if (!name) {
      const sql = plans.truncateTable(this.config, 'job')
      await this.db.executeSql(sql)
      return
    }

    Attorney.assertQueueName(name)
    const { table, partition } = await this.getQueueCache(name)

    if (partition) {
      const sql = plans.truncateTable(this.config, table)
      await this.db.executeSql(sql)
    } else {
      const sql = plans.deleteAllJobs(this.config, table)
      await this.db.executeSql(sql, [name])
    }
  }

  // Returns a single datapoint (as a one-element array, newest first) built from the cached counts
  // the monitor maintains on the queue table — cheap, and avoids re-running the job-table aggregate
  // on every call. The aggregate runs only when { force: true } is passed or the cache is missing/
  // stale; either way the fresh counts are written back to the cache so later reads stay cheap.
  // Throws if the queue doesn't exist. For the cached counts as a single value, use getQueue(name).
  async getQueueStats (name: string, options: types.QueueStatsOptions = {}): Promise<types.QueueStats[]> {
    Attorney.assertQueueName(name)

    const toSnapshot = (row: any): types.QueueStats => {
      const snapshot: types.QueueStats = {
        name,
        deferredCount: 0,
        queuedCount: 0,
        readyCount: 0,
        activeCount: 0,
        failedCount: 0,
        totalCount: 0,
        // sqlite returns timestamps as ISO text; the pg driver returns Date.
        capturedOn: typeof row?.capturedOn === 'string' ? new Date(row.capturedOn) : (row?.capturedOn ?? new Date())
      }

      for (const field of STATS_COUNT_FIELDS) {
        const value = row?.[field]
        if (value !== undefined && value !== null) snapshot[field] = value
      }

      return snapshot
    }

    // Serve the cached counts the monitor keeps on the queue table. capturedOn is monitor_on — NULL
    // if never monitored, or old if monitoring has since been turned off. Serve the cache while it's
    // within budget; otherwise recompute and re-cache. { force: true } applies a much tighter budget
    // (a fresh reading), but still reuses a value computed in the last minute so repeated forced
    // calls don't each re-run the aggregate.
    const cacheSql = plans.getQueueStatsCache(this.config)
    const { rows: cacheRows } = await this.db.executeSql(cacheSql, [name])
    const cached = cacheRows.at(0)

    if (!cached) {
      throw new Error(`Queue ${name} does not exist`)
    }

    const maxCacheAgeMs = (options.force
      ? QUEUE_STATS_FORCE_TTL_SECONDS
      : Math.max(
        QUEUE_STATS_CACHE_TTL_SECONDS,
        this.config.monitorIntervalSeconds ?? 0,
        this.config.superviseIntervalSeconds ?? 0
      )
    ) * 1000

    const cacheAgeMs = cached.capturedOn == null
      ? Infinity
      : Date.now() - new Date(cached.capturedOn).getTime()

    if (cacheAgeMs <= maxCacheAgeMs) {
      return [toSnapshot(cached)]
    }

    const refreshSql = plans.refreshQueueStats(this.config, cached.table, name)
    const { rows: refreshed } = await this.db.executeSql(refreshSql)

    return [toSnapshot(refreshed.at(0) ?? cached)]
  }

  async getJobById<T>(name: string, id: string, options: types.ConnectionOptions = {}): Promise<types.JobWithMetadata<T> | null> {
    Attorney.assertQueueName(name)

    const db = this.assertDb(options)

    const { table } = await this.getQueueCache(name)

    const sql = plans.getJobById(this.config, table)

    const result1 = await db.executeSql(sql, [name, id])

    if (result1?.rows?.length === 1) {
      const row = result1.rows[0]

      if (this.config.dialect?.name === 'sqlite') {
        coerceSqliteJobRow(row)
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

    const sql = plans.findJobs(this.config, table, {
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

    const rows = result?.rows || []

    if (this.config.dialect?.name === 'sqlite') {
      for (const row of rows) coerceSqliteJobRow(row)
    }

    return rows
  }

  async getDependencies (name: string, id: string, options: types.ConnectionOptions = {}): Promise<types.DependencyRef[]> {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const sql = plans.getDependencies(this.config)
    const { rows } = await db.executeSql(sql, [name, id])
    return rows.map((r: any) => ({ name: r.parentName, id: r.parentId }))
  }

  async getDependents (name: string, id: string, options: types.ConnectionOptions = {}): Promise<types.DependencyRef[]> {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const sql = plans.getDependents(this.config)
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
