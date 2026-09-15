import assert, { notStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import { serializeError as stringify } from 'serialize-error'
import * as Attorney from './attorney.ts'
import type Db from './db.ts'
import { TRANSACTION_ROLLBACK_TIMEOUT_MS } from './db.ts'
import type Notifier from './notifier.ts'
import * as plans from './plans.ts'
import type Timekeeper from './timekeeper.ts'
import * as timekeeper from './timekeeper.ts'
import { resolveWithinSeconds } from './tools.ts'
import * as types from './types.ts'
import Worker from './worker.ts'
import { JobSpy, type JobSpyInterface } from './spy.ts'

const INTERNAL_QUEUES = Object.values(timekeeper.QUEUES).reduce<Record<string, string | undefined>>((acc, i) => ({ ...acc, [i]: i }), {})

// postgres: current transaction is aborted, commands ignored until end of transaction block
const TRANSACTION_ABORTED = '25P02'

// pg's own default when the pool size is not configured. Used to tell a transactional worker how
// much room it actually has, since each handler in flight holds a connection of its own.
const DEFAULT_POOL_MAX = 10

const WARNING_TYPES = {
  TRANSACTIONAL_POOL_HEADROOM: 'transactional_pool_headroom',
  TRANSACTION_TIMEOUT_PROBE: 'transaction_timeout_probe'
} as const

const TRANSACTIONAL_HEARTBEAT_UNSUPPORTED = 'this backend cannot run a transactional worker on a queue with heartbeatSeconds: the heartbeat refreshes the claimed row from a pooled connection, which the handler transaction is then refused a write to. Drop heartbeatSeconds and let expireInSeconds bound the job, or drop transactional and settle it with complete({ db })'

// The same refusal from inside a batch, where the queue passed work()'s check and the heartbeat
// arrived afterwards: on the job itself (heartbeatSeconds on send()), or on the queue, through
// updateQueue() or through a createQueue() that work() ran ahead of. Pointing at the queue's
// configuration there would send the user to a setting that is not the one they need to drop.
const TRANSACTIONAL_HEARTBEAT_ON_BATCH = 'this backend cannot run a transactional handler over a job with heartbeatSeconds: the heartbeat refreshes the claimed row from a pooled connection, which the handler transaction is then refused a write to. The queue carried no heartbeat when this worker registered, so it came from the job (heartbeatSeconds on send()) or from the queue after registration. Drop it there and let expireInSeconds bound the job, or drop transactional and settle it with complete({ db })'

// Candidates for bounding a transactional handler's transaction from the database side, best
// first. transaction_timeout covers the whole transaction; idle_in_transaction_session_timeout only
// covers the gaps between statements, which still catches a handler that stops issuing them.
// statement_timeout is deliberately absent: it bounds one statement, and leaves the next one with
// 25P02, which would have the aborted-transaction message blame the handler for a SQL error it
// never swallowed.
const TRANSACTION_TIMEOUT_GUCS = ['transaction_timeout', 'idle_in_transaction_session_timeout'] as const

// current_setting(name, true) answers NULL for a parameter the server does not recognise, on every
// backend pg-boss supports, so which of the two is available takes one statement and no version
// parsing. transaction_timeout arrived in PostgreSQL 17 and exists on CockroachDB; asking for it on
// 13-16 any other way is a hard error.
const TRANSACTION_TIMEOUT_PROBE = `SELECT ${TRANSACTION_TIMEOUT_GUCS.map(name => `current_setting('${name}', true) AS ${name}`).join(', ')}`

// The tighter of pg-boss's bound ($2, milliseconds) and the one the connection already carries for
// GUC $1. A role, a managed provider or a pooler that sets idle_in_transaction_session_timeout means
// it, and the transactions this runs on are the longest ones pg-boss opens, so overwriting it is
// exactly the wrong place to do so. pg_settings reports both GUCs unitless in milliseconds on every
// backend that has them, which current_setting does not, so the comparison needs no parsing and no
// second round trip. LEAST ignores nulls, which covers both cases where there is nothing to be
// tighter than: 0 is how either GUC spells "no bound" (NULLIF turns it into one of them), and a
// backend that recognises the parameter without listing it in pg_settings is the other. Read per
// transaction rather than cached, since the value belongs to the connection and not to the process.
const TRANSACTION_TIMEOUT_TIGHTEST = 'LEAST($2::bigint, NULLIF((SELECT s.setting::bigint FROM pg_settings s WHERE s.name = $1), 0))'

// Applies the bound. This is the first statement of the handler's transaction, so it must not be
// the first place a statement can fail: the read half is rehearsed by the probe below, on the
// pooled connection, and only set_config is new here. Sharing the expression is what keeps the two
// from drifting apart.
const TRANSACTION_TIMEOUT_APPLY = `SELECT set_config($1, ${TRANSACTION_TIMEOUT_TIGHTEST}::text, true)`

// The read half of the apply, run once by the probe with a bound of 0 so it can set nothing. A
// backend or a db adapter that answers current_setting but has no pg_settings view fails here,
// where failing costs the bound, rather than inside the transaction, where it would cost the batch.
// set_config is left out on purpose: a custom adapter's executeSql may sit inside the caller's own
// open transaction, and a rehearsal must not be able to change anything there.
const TRANSACTION_TIMEOUT_REHEARSE = `SELECT ${TRANSACTION_TIMEOUT_TIGHTEST}`

// How long a refused probe is remembered before the next transactional batch asks again. The bound
// is a backstop, so the retry has to stay; a backend that will never answer does not need to be
// asked on every batch for the life of the process either.
const TRANSACTION_TIMEOUT_PROBE_COOLDOWN_MS = 60_000

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

// The count columns shared by live stats and recorded snapshots (the QueueStats shape).
const STATS_COUNT_FIELDS = [
  'deferredCount',
  'queuedCount',
  'readyCount',
  'activeCount',
  'failedCount',
  'totalCount'
] as const

// Stale-cache budget for getQueueStats when persistQueueStats is off. A queue-table cache older than
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
  warning: 'warning',
  wip: 'wip'
}

// The fetch options that were performance escapes from the fetch's sort. The index is now ordered to
// match the fetch, so they escape nothing — `priority: false` is the only remaining shape that
// still full-sorts, making it slower than the default it was meant to beat. Accepted and ignored
// for now; removed in the next major.
const DEPRECATED_FETCH_OPTIONS = ['priority', 'orderByCreatedOn'] as const

// Shared code for both options, so --no-deprecation and friends can be scoped to this one change.
const DEPRECATED_FETCH_OPTIONS_CODE = 'PGBOSS_DEP_FETCH_SORT'

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
  // Warn once per option per instance, not once per fetch.
  #warnedFetchOptions = new Set<string>()
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
  // Job ids a transactional handler settled itself through the transaction it was handed, keyed on
  // that transaction's db. #processJobs reads it to interpret its own completion; see the check
  // there. Weak because the key is the transaction, so an entry goes away with it.
  #handlerSettledJobs: WeakMap<types.IDatabase, Set<string>>
  // Which GUC this server bounds a transaction with, resolved on the first transactional batch and
  // kept for the life of the process. Resolving to null means neither is recognised, or the probe
  // itself failed; a failed probe clears the memo and sets the instant before which no batch asks
  // again.
  #transactionTimeoutGuc: Promise<string | null> | null
  #transactionTimeoutProbeRetryAt: number
  #transactionTimeoutProbeCooldownMs: number
  // One warning per process for a probe the server will not answer. A backend or adapter that
  // cannot answer it today will not answer it tomorrow, so there is no episode to report twice.
  #warnedTransactionTimeoutProbe: boolean
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
    this.#handlerSettledJobs = new WeakMap()
    this.#transactionTimeoutGuc = null
    this.#transactionTimeoutProbeRetryAt = 0
    this.#transactionTimeoutProbeCooldownMs = config.__test__transactionTimeoutProbeCooldownMs ?? TRANSACTION_TIMEOUT_PROBE_COOLDOWN_MS
    this.#warnedTransactionTimeoutProbe = false
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
      await this.#trackJobsFailed(name, jobs, err)
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
      // Dependency unblocking is handled out of band by the background resolver (Navigator), so
      // completion is a single statement here too.
      const sql = plans.completeJobsWithOutputsDistributed(this.config.schema, table)
      const { rows } = await this.db.executeSql(sql, [name, JSON.stringify(payload)])
      return { jobs: ids, requested: ids.length, affected: rows.length }
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
      return this.ensureTransaction(this.db, async (tx) => {
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

  /**
   * Runs a batch through its handler and settles it.
   *
   * With `transactional`, the handler and the completion run in one transaction of their own. The
   * batch is already claimed by the time this is called, so the transaction covers the handler's
   * writes and the completion and nothing else: success commits them together, and a throw rolls
   * both back and then fails the jobs on a pooled connection, where the retry accounting is the
   * same as any other worker's. Because the claim is outside the transaction, the jobs stay
   * visibly `active` throughout, which is what keeps heartbeats, `expireInSeconds`, and another
   * instance's supervisor working on them as usual.
   */
  async #processJobs<T> (
    name: string,
    jobs: types.Job<T>[],
    callback: types.WorkHandler<T>,
    worker?: Worker<T>,
    heartbeatRefreshSeconds?: number,
    perJobResults = false,
    transactional = false,
    transactionTimeoutSeconds?: number
  ): Promise<void> {
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
      worker.aborted = false
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
    // Only for a transactional worker, and only from the begin below until it settles. rollback()
    // is idempotent, so the catch can settle it without tracking whether the commit got there
    // first.
    let transaction: types.TransactionHandle | null = null

    try {
      // A per-job heartbeatSeconds, or updateQueue() after the worker registered, can put a
      // heartbeat on a batch whose queue carried none at work(), which that check cannot see. Thrown
      // before the begin so the batch takes the ordinary failure path rather than the backend's raw
      // write conflict.
      assert(!(transactional && heartbeatSeconds > 0 && this.config.noTransactionalHeartbeat), TRANSACTIONAL_HEARTBEAT_ON_BATCH)

      if (transactional) {
        const timeoutMs = transactionTimeoutSeconds !== undefined
          ? transactionTimeoutSeconds * 1000
          : maxExpiration * 1000 + TRANSACTION_ROLLBACK_TIMEOUT_MS

        // Asked before the begin. The probe runs on a pooled connection, and a pool whose
        // connections the handlers in flight are already holding has none to hand it: the wait
        // would then be connectionTimeoutMillis long, with this transaction open across it, and
        // the bound lost for the whole cooldown after. Memoized after the first batch either way.
        const timeoutGuc = timeoutMs > 0 ? await this.#resolveTransactionTimeoutGuc() : null

        transaction = await this.db.beginTransaction!()
        this.#handlerSettledJobs.set(transaction.db, new Set())

        if (timeoutGuc) {
          await this.#applyTransactionTimeout(transaction, timeoutGuc, timeoutMs)
        }
      }

      const handling = transaction
        ? (callback as unknown as types.TransactionalWorkHandler<T>)(jobs, transaction.db)
        : callback(jobs)

      const result = await resolveWithinSeconds(handling, maxExpiration, `handler execution exceeded ${maxExpiration}s`, ac)

      // An abort resolves the race rather than rejecting it, so on this line an abandoned handler
      // looks exactly like one that returned. failWip() aborts after failing the batch, so
      // committing here would leave whatever the handler had written by then in the database
      // beside a job that is already failed: the split a transactional worker exists to prevent.
      // Rolling back instead takes the same path a throw takes, and the fail that follows finds
      // the jobs already settled and does nothing. The worker's flag rather than the signal,
      // because resolveWithinSeconds cancels its own timeout through the same controller and so
      // leaves the signal aborted on every ordinary completion too.
      if (transaction && worker?.aborted) {
        throw new Error('pg-boss shut down while the handler was still running')
      }

      if (perJobResults) {
        // #settlePerJob settles each job individually and does its own (synchronous,
        // lookup-free) spy tracking via #trackJobsSettled, so the deferred tracker below
        // is skipped for this path.
        await this.#settlePerJob(name, jobs, result)
      } else {
        // Read out before the completion below, which goes through the same complete() and would
        // otherwise record pg-boss's own settle as one the handler made.
        const settledByHandler = transaction ? this.#takeHandlerSettles(transaction) : null

        const completion = await this.complete(name, jobIds, jobIds.length === 1 ? result : undefined, transaction ? { db: transaction.db } : undefined)
        completedResult = result
        completedAffected = completion.affected

        if (settledByHandler) {
          this.#assertClaimHeld(jobIds, completion.affected, settledByHandler)
        }
      }

      if (transaction) {
        await transaction.commit()
      }
    } catch (err: any) {
      if (transaction) {
        // Before the fail, not after: fail() runs on a pooled connection and would otherwise wait
        // on the job rows this transaction still holds locked.
        await transaction.rollback()

        // A handler that catches a SQL error it raised through the transaction leaves that
        // transaction aborted, and postgres then rejects every later statement in it with 25P02,
        // including the completion pg-boss runs there. Name the cause, since the raw message
        // arrives with nothing to connect it to the handler.
        if (err?.code === TRANSACTION_ABORTED) {
          err.message = `${err.message} (the handler left its transaction aborted: let a SQL error raised through tx propagate out of the handler, or isolate the statement with a SAVEPOINT)`
        }
      }

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

  /**
   * Gives the handler's transaction a deadline the database enforces.
   *
   * Everything else bounding it lives in this process: `resolveWithinSeconds` and the deadline
   * `rollback()` races its ROLLBACK against. Those cover a handler that hangs. They do not cover
   * the process itself failing under it (a starved event loop, a driver wedged below the promise),
   * which is the case that matters most. An open transaction keeps advertising `backend_xmin` and
   * holds vacuum off the whole database for as long as it lasts, which is the condition
   * `monitorVacuum` and the `xmin_horizon` warning exist to report, and this option is what makes a
   * long-lived transaction reachable from user code in the first place.
   *
   * The default is derived from `expireInSeconds` rather than matched to it. Matching would make
   * the diagnosis a coin flip between `handler execution exceeded Ns` with a clean rollback and a
   * killed connection, and the transaction is open wider than the handler anyway (BEGIN precedes
   * it, the completion and COMMIT follow it), so an equal bound would kill a batch that had already
   * succeeded at its commit. `expireInSeconds` is also the supervisor's reclaim bound, and a third
   * actor on that instant helps nobody. With the rollback deadline added on top, this only fires
   * once the whole Node path has failed, which is when the server should be the one to give up.
   *
   * Issued here on `tx.db` rather than as a `beginTransaction()` argument: that method is public
   * `IDatabase` surface, so an adapter that ignored a new parameter would drop the bound silently.
   * `set_config` with the value bound rather than a built `SET LOCAL` string, so it is one
   * parameterized statement and portable to drivers that reject multi-statement queries.
   */
  async #applyTransactionTimeout (transaction: types.TransactionHandle, guc: string, timeoutMs: number) {
    await transaction.db.executeSql(TRANSACTION_TIMEOUT_APPLY, [guc, `${Math.round(timeoutMs)}`])
  }

  /**
   * Which GUC this server bounds a transaction with, or null if neither is available and the
   * transaction runs unbounded.
   *
   * Asked on the pooled connection rather than the handler's, even though the bound is applied on
   * the handler's. A statement that errors leaves its transaction aborted, so a probe the backend
   * or a `db` adapter cannot answer would poison the very transaction it was meant to protect and
   * every handler statement after it would come back 25P02 blaming the handler for a SQL error it
   * never raised. Off the transaction, a failed probe costs the bound and nothing else.
   *
   * Asked before the begin for the same reason it is asked off the transaction: a pool whose
   * connections the handlers in flight are holding has none left for the probe, so a probe issued
   * after the begin waits out `connectionTimeoutMillis` with that transaction open and then loses
   * the bound for the whole cooldown. Only the first batch of a process pays anything here.
   *
   * The apply statement also reads pg_settings, and it runs as the first statement of the handler's
   * transaction, so the probe rehearses that read here as well. Otherwise a backend with the GUC but
   * without the catalog view would fail every batch, silently as far as the warning system goes,
   * which is the failure the probe exists to keep out of the transaction.
   *
   * The bound is a backstop against a process that has already failed, so losing it degrades rather
   * than fails the batch: warn once, run this batch unbounded, and ask again once the cooldown has
   * passed instead of running unbounded for the life of the process, or asking on every batch.
   */
  #resolveTransactionTimeoutGuc (): Promise<string | null> {
    if (!this.#transactionTimeoutGuc && Date.now() < this.#transactionTimeoutProbeRetryAt) {
      return Promise.resolve(null)
    }

    this.#transactionTimeoutGuc ??= this.db.executeSql(TRANSACTION_TIMEOUT_PROBE)
      .then(({ rows }) => TRANSACTION_TIMEOUT_GUCS.find(name => rows[0][name] !== null) ?? null)
      .then(async guc => {
        if (guc) await this.db.executeSql(TRANSACTION_TIMEOUT_REHEARSE, [guc, '0'])
        return guc
      })
      .catch((err: any) => {
        this.#transactionTimeoutGuc = null
        this.#transactionTimeoutProbeRetryAt = Date.now() + this.#transactionTimeoutProbeCooldownMs

        if (!this.#warnedTransactionTimeoutProbe) {
          this.#warnedTransactionTimeoutProbe = true

          this.emit(events.warning, {
            message: `could not ask this server which transaction timeout it supports, or read the bound it already carries, so transactional handlers run with no database-side bound until the next probe: ${err.message}`,
            data: { type: WARNING_TYPES.TRANSACTION_TIMEOUT_PROBE }
          })
        }

        return null
      })

    return this.#transactionTimeoutGuc
  }

  /**
   * Guards the commit of a transactional batch on the worker still holding the claim it opened the
   * transaction with.
   *
   * `complete()` only settles a job that is still `active`, so a short count means the rows were
   * taken out of that state while the handler ran. Two things do that. The handler may have settled
   * the jobs itself with `complete()`, `fail()`, `cancel()` or `deleteJob()` on `{ db: tx }`, which
   * is a documented pattern and leaves pg-boss's own completion with nothing to update; those calls
   * record their ids as they land, so they cost no round trip to recognise. Anything left over is a
   * claim that went away: an operator's `cancel()` or `fail()`, a heartbeat the database stopped
   * seeing, `expireInSeconds`, another instance's supervisor. That job is going to run again, so
   * committing the handler's writes beside it produces exactly the duplicate side effect this
   * option exists to prevent. Throwing rolls them back and takes the ordinary failure path, which
   * records the failure against whatever state the job is in by then.
   *
   * A handler that settles its own jobs by writing the job table directly also lands here, since
   * nothing about a raw `UPDATE` is recognisable as a settle. That is a narrowing rather than a
   * regression: direct writes to the job table were never supported. The message has to offer that
   * reading anyway, so the diagnosis is not sent after a claim that was never lost.
   */
  #assertClaimHeld (jobIds: string[], affected: number, settledByHandler: Set<string>) {
    const accounted = affected + jobIds.filter(id => settledByHandler.has(id)).length

    if (accounted < jobIds.length) {
      throw new Error(`${jobIds.length - accounted} of ${jobIds.length} job(s) were no longer claimed by this worker when the handler returned, so the transaction was rolled back. Either something took the claim away (expireInSeconds, a heartbeat the database stopped seeing, an operator's cancel() or fail(), another instance's supervisor), or the handler settled the job with SQL of its own instead of complete(), fail(), cancel() or deleteJob() on { db: tx }`)
    }
  }

  // The ids the handler settled through its transaction. Taken rather than read, so the completion
  // pg-boss runs next on the same transaction does not add itself to the set.
  #takeHandlerSettles (transaction: types.TransactionHandle): Set<string> {
    const settled = this.#handlerSettledJobs.get(transaction.db) ?? new Set<string>()
    this.#handlerSettledJobs.delete(transaction.db)
    return settled
  }

  // Records a settle a transactional handler ran through the transaction it was handed. A no-op for
  // every other caller: only a transaction #processJobs opened is in the map.
  //
  // Records the ids the statement touched rather than the ids it was asked about, because the two
  // differ in both directions. complete() on a job a peer already moved out of `active` updates no
  // rows, and recording that as the handler's settle would account for a job nobody settled and let
  // the batch commit, which is the duplicate #assertClaimHeld exists to stop. A handler that
  // settles part of its own batch first then asks about all of it lands short for the opposite
  // reason, and reading that as a lost claim would throw away a batch that did what it was asked.
  // The count alone cannot tell those apart; the ids can, and the statement already returns them.
  #trackHandlerSettle (options: types.ConnectionOptions, response: types.CommandResponse) {
    const settled = options.db && this.#handlerSettledJobs.get(options.db)

    if (!settled) return

    // Without the ids there is no way to attribute a short count, so fall back to the all-or-nothing
    // reading: a full settle is the handler's, anything less is left for #assertClaimHeld to judge.
    const landed = response.settled ?? (response.affected < response.requested ? [] : response.jobs)

    for (const id of landed) {
      settled.add(id)
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

  #evictQueueCache (name: string) {
    if (this.queues) delete this.queues[name]
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

  // Last step of a shutdown: closing the pool, marking the instance stopped, and emitting
  // `stopped` all wait on this, so every worker has to be reached even when one of them cannot be
  // failed.
  async failWip () {
    for (const worker of this.workers.values()) {
      const jobIds = worker.jobs.map(j => j.id)

      if (jobIds.length) {
        // The fail goes in before the abort, so it lands while the handler is still holding the
        // jobs active and its completion finds nothing to settle. Its own failure is reported
        // rather than thrown: the remaining workers still have to be aborted.
        try {
          await this.fail(worker.name, jobIds, 'pg-boss shut down while active')
        } catch (err: any) {
          try {
            this.emit(events.error, { ...err, message: err.message, stack: err.stack, queue: worker.name, worker: worker.id })
          } catch {
            // An `error` event nobody listens for throws ERR_UNHANDLED_ERROR straight back out of
            // emit(). Counting listeners here would not see it: the PgBoss instance re-emits this
            // event, so the throw comes from an application with no `error` handler, one frame
            // further out than this emitter can measure. Reporting the failure matters less than
            // reaching the workers after this one, the pool close, and the `stopped` event.
          }
        }
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
      transactional = false,
      transactionTimeoutSeconds,
    } = options

    // Capability check rather than a check for the built-in pool, so a db adapter that implements
    // beginTransaction can serve transactional workers too. Asserted at work() time so the mistake
    // surfaces on the call rather than on the first fetch.
    if (transactional) {
      assert(typeof this.db.beginTransaction === 'function',
        'transactional workers require a database connection pg-boss can open a transaction on: the built-in pool, or a db adapter implementing beginTransaction')

      await this.#assertTransactionalHeartbeatSupported(name)

      this.#warnOnTransactionalPoolHeadroom(localConcurrency)
    }

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
          await this.#processJobs(name, jobs, callback, worker, heartbeatRefreshSeconds, perJobResults, transactional, transactionTimeoutSeconds)
        } else {
          const { allowed, excess, groupedJobs } = this.#trackLocalGroupStart(name, jobs)

          try {
            if (excess.length > 0) {
              const excessIds = excess.map(job => job.id)
              await this.restore(name, excessIds)
            }

            if (allowed.length > 0) {
              await this.#processJobs(name, allowed, callback, worker, heartbeatRefreshSeconds, perJobResults, transactional, transactionTimeoutSeconds)
            }
          } finally {
            this.#trackLocalGroupEnd(name, groupedJobs)
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

  /**
   * Refuses a transactional worker on a queue that configures heartbeats, where the backend cannot
   * carry both.
   *
   * `touch()` refreshes `heartbeat_on` on the claimed row from a pooled connection so the job stays
   * visibly `active` while the handler runs. Under CockroachDB's serializable isolation that write
   * lands above the handler transaction's timestamp and the completion pg-boss runs inside the
   * transaction then cannot write the same row: `40001` WriteTooOldError, every batch. The
   * transaction has already returned rows to the handler, so there is no read timestamp left to
   * refresh and no retry to make in place.
   *
   * Neither half survives being dropped quietly. Skipping the refresh would leave `heartbeat_on`
   * to go stale under a live handler, and `failJobsByHeartbeat` would reclaim exactly the
   * long-running jobs heartbeats exist for, so the batch would roll back and retry forever with
   * nothing in the output to say why. Rejecting at registration says it once, where the
   * configuration is.
   *
   * Only queried on a backend that sets the flag, so `work()` stays off the database everywhere
   * else. A per-job `heartbeatSeconds` can still override a queue that has none, which this call
   * cannot see; #processJobs catches that from the batch itself.
   */
  async #assertTransactionalHeartbeatSupported (name: string) {
    if (!this.config.noTransactionalHeartbeat) return

    // A queue that does not exist yet cannot be read, and work() has never required one. The batch
    // check is the backstop either way.
    const queue = await this.getQueue(name).catch(() => null)

    assert(!queue?.heartbeatSeconds, TRANSACTIONAL_HEARTBEAT_UNSUPPORTED)
  }

  // Each transactional handler in flight holds a pool connection for its own duration, so a pool
  // sized at or below the number of them has nothing left for the fetches, the failures, or
  // maintenance: those wait out connectionTimeoutMillis and then reject. Only measurable for the
  // built-in pool, and a warning rather than an assert, because the ceiling is the operator's call.
  //
  // Emitted only, never persisted. The `warning` table records episodes, and every type in it is
  // deduped by a flag that clears when the condition does. This one is an assertion about static
  // configuration with no episode behind it: `max` is fixed for the life of the process, so every
  // later transactional work() call trips it again with a larger `pinned`, and every restart writes
  // the same rows once more. Persisting it would bury the warnings someone actually needs.
  #warnOnTransactionalPoolHeadroom (localConcurrency: number) {
    if (!this.db._pgbdb) return

    const max = this.config.max ?? DEFAULT_POOL_MAX
    const running = [...this.workers.values()].filter(worker => worker.options.transactional).length
    const pinned = running + localConcurrency

    if (pinned < max) return

    this.emit(events.warning, {
      message: `transactional workers can hold ${pinned} of this pool's ${max} connections while their handlers run, leaving nothing for fetches, failures, or maintenance. Raise max above ${pinned}, or lower localConcurrency.`,
      data: { type: WARNING_TYPES.TRANSACTIONAL_POOL_HEADROOM, max, transactionalWorkers: pinned }
    })
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

    const results = await Promise.allSettled(rows.map(({ name }) => this.send(name, data, options)))

    const failures = results
      .map((result, index) => ({ result, name: rows[index].name }))
      .filter((entry): entry is { result: PromiseRejectedResult, name: string } => entry.result.status === 'rejected')

    if (failures.length > 0) {
      // Each entry names its own queue, so attribution doesn't depend on lining errors[] up with
      // the queue order positionally, and survives two subscribers failing with identical text.
      throw new AggregateError(
        failures.map(({ name, result }) => `${name}: ${result.reason?.message ?? result.reason}`),
        `publish('${event}') failed for ${failures.length} of ${results.length} subscribed queue(s)`
      )
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

    return {
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
    }
  }

  async createJob (request: types.Request): Promise<string | null> {
    const { name, data = null, options = {} } = request
    const { db: wrapper, singletonSeconds, singletonNextSlot } = options

    const job = this.#toJobPayload(name, data, options)

    const db = wrapper || this.db

    const { table, policy, notify } = await this.getQueueCache(name)

    if (policy === plans.QUEUE_POLICIES.key_strict_fifo && !job.singletonKey) {
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

  // Builds the partial-edit payload for update()/upsert(): ONLY the fields the caller actually
  // supplied end up as keys (undefined is dropped by JSON.stringify), so plans.updateJob leaves
  // every other column untouched. Compatible with both plans.updateJob ($1 = this object) and
  // plans.insertJobs ($1 = [this object]), whose json_to_recordset treats absent keys as null.
  #toUpdatePayload (data: object | null | undefined, options: types.UpdateOptions) {
    return {
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
    }
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

    const sql = plans.updateJob(this.config.schema, table, name, by, match, this.#notifyEnabled(notify))
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
    const { table, policy, notify } = await this.getQueueCache(name)

    const by = opts.id ? 'id' : 'singletonKey'
    const match = opts.match ?? 'newest'

    // The insert-on-miss path needs a singletonKey on key_strict_fifo queues (a keyless job would
    // violate the queue's check constraint), so reject upfront — including the id-target case.
    if (policy === plans.QUEUE_POLICIES.key_strict_fifo && !opts.singletonKey) {
      throw new Error(`${plans.QUEUE_POLICIES.key_strict_fifo} queues require a singletonKey`)
    }

    const notifyEnabled = this.#notifyEnabled(notify)
    const updateSql = plans.updateJob(this.config.schema, table, name, by, match, notifyEnabled)
    const insertSql = plans.insertJobs(this.config.schema, { table, name, returnId: true, notify: notifyEnabled })

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
    if (result.inserted && this.config.__test__enableSpies) {
      const spy = this.#spies.get(name)
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
    // __singletonSlots is the cron pass's own opt-in, not a documented insert option: it lets a job
    // name the throttle slot it is filed in, which is how a scheduled occurrence pins its slot to
    // the occurrence rather than to insert time. Without it the column is neither declared in the
    // statement nor kept on the objects below, so this stays the raw path it has always been.
    options: types.InsertOptions & { __singletonSlots?: boolean } = {}
  ) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const slots = options.__singletonSlots === true

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

    const { table, policy, notify } = await this.getQueueCache(name)

    if (policy === plans.QUEUE_POLICIES.key_strict_fifo) {
      for (const job of jobs) {
        if (!job.singletonKey) {
          throw new Error(`${plans.QUEUE_POLICIES.key_strict_fifo} queues require a singletonKey`)
        }
      }
    }

    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined

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
        __singletonSlot,
        ...rest
      } = j as types.JobInsert & { blocked?: unknown, blocking?: unknown, pendingDependencies?: unknown, __singletonSlot?: string }

      // Reattached only for the caller that asked for the column, so a public insert() drops the
      // field rather than handing an unvalidated value to a timestamp cast.
      if (slots && __singletonSlot !== undefined) {
        Object.assign(rest, { __singletonSlot })
      }

      // Flatten group to the column names insertJobs' json_to_recordset declares, matching
      // send()/upsert()/flow(). Assigned only when a group is present: those same raw column
      // names are accepted by the recordset directly, and unconditional keys would overwrite
      // them with undefined — silently breaking anyone who passed groupId/groupTier as a
      // workaround while insert() was dropping `group` entirely.
      if (group) {
        Object.assign(rest, { groupId: group.id, groupTier: group.tier })
      }

      // insert() otherwise skips Attorney, but a zone-less date time string still has to be pinned
      // to UTC: without it the same string resolves in the database session's TimeZone here while
      // resolving as UTC through send(), so one API would schedule a different instant than the other.
      if (typeof rest.startAfter === 'string') {
        rest.startAfter = Attorney.pinZonelessDateTime(rest.startAfter)
      }

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

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId, notify: this.#notifyEnabled(notify), slots })

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

  // A DeprecationWarning rather than a pg-boss `warning` event, because the two answer different
  // questions. Every `warning` type is a database or queue health condition an operator watches and
  // acts on; this is a code change a developer has to make, and what they need is the call site.
  // process.emitWarning gives them that: --trace-deprecation prints the stack to the offending
  // fetch()/work(), --throw-deprecation fails a build on it, --no-deprecation silences it.
  //
  // Only fires when the option is explicitly disabled: work() forwards both keys with their
  // defaults on every poll, so testing for presence would warn on every fetch in the process.
  #warnDeprecatedFetchOptions (options: types.FetchOptions) {
    for (const option of DEPRECATED_FETCH_OPTIONS) {
      if (options[option] === false && !this.#warnedFetchOptions.has(option)) {
        this.#warnedFetchOptions.add(option)
        process.emitWarning(
          `${option}: false is deprecated and now ignored — jobs are always fetched in priority and creation order. Remove it; it will be rejected in the next major.`,
          'DeprecationWarning',
          DEPRECATED_FETCH_OPTIONS_CODE
        )
      }
    }
  }

  fetch<T>(name: string): Promise<types.Job<T>[]>
  fetch<T>(name: string, options: types.FetchOptions & { includeMetadata: true }): Promise<types.JobWithMetadata<T>[]>
  fetch<T>(name: string, options: types.FetchOptions): Promise<types.Job<T>[]>
  async fetch (name: string, options: types.FetchOptions = {}) {
    Attorney.checkFetchArgs(name, options)

    this.#warnDeprecatedFetchOptions(options)

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
    } catch (err: any) {
      // The only fetch error we tolerate is a unique-constraint violation (SQLSTATE 23505) from a
      // policy/singleton index when a concurrent fetch won the same slot — treat that as an empty
      // fetch. Anything else (a DB outage, a malformed query) must surface: swallowing it turned
      // every failed fetch into a silent [] with no error event, indistinguishable from an empty
      // queue. Rethrowing routes it to the worker's onError (emits `error`) or to a direct caller.
      if (err?.code !== '23505') throw err
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
      affected: result && result.rows ? parseInt(result.rows[0].count) : 0,
      // The settle statements aggregate the ids they touched beside the count; the read-only
      // mutators that share this mapper (resume, restore, retry, touch) do not, so it stays
      // optional and #trackHandlerSettle falls back to the count when it is absent.
      settled: result?.rows?.[0]?.ids
    }
  }

  async complete (name: string, id: string | string[], data?: object | null, options: types.CompleteOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'complete')
    const { table } = await this.getQueueCache(name)
    const outputData = this.mapCompletionDataArg(data)

    let response: types.CommandResponse

    // noMultiMutationCte: split the dependency-unblocking into a separate statement to
    // avoid CockroachDB's multi-mutation CTE limitation (completeJobs updates two tables).
    if (this.config.noMultiMutationCte) {
      response = await this.completeDistributed(name, ids, outputData, table, db, options.includeQueued)
    } else {
      const sql = plans.completeJobs(this.config.schema, table, options.includeQueued)
      const result = await db.executeSql(sql, [name, ids, outputData])
      response = this.mapCommandResponse(ids, result)
    }

    this.#trackHandlerSettle(options, response)

    return response
  }

  // Distributed complete/fail need several statements run atomically. When we own the pooled
  // connection we pin a single client via withTransaction(); when the caller supplied their own
  // db (options.db) we run the statements inline so they compose inside the caller's transaction
  // rather than issuing a BEGIN/COMMIT that would commit or roll back their outer work.
  private async ensureTransaction<T> (db: types.IDatabase, fn: (tx: types.IDatabase) => Promise<T>): Promise<T> {
    if (db === this.db && this.db._pgbdb) {
      return this.db.withTransaction(fn)
    }

    return fn(db)
  }

  private async completeDistributed (name: string, ids: string[], outputData: any, table: string, db: types.IDatabase, includeQueued?: boolean): Promise<types.CommandResponse> {
    // Dependency unblocking is handled out of band by the background resolver (Navigator), so
    // completion is a single statement on every backend.
    const sql = plans.completeJobsDistributed(this.config.schema, table, includeQueued)
    const { rows } = await db.executeSql(sql, [name, ids, outputData])
    return { jobs: ids, requested: ids.length, affected: rows.length, settled: rows.map(row => row.id) }
  }

  async fail (name: string, id: string | string[], data?: any, options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'fail')
    const { table } = await this.getQueueCache(name)
    const outputData = this.mapCompletionDataArg(data)

    let response: types.CommandResponse

    // noMultiMutationCte: use separate queries to avoid CockroachDB's multi-mutation CTE limitation.
    // The delete and re-insert run in a single transaction (see ensureTransaction) so the
    // job cannot be lost between the two statements.
    if (this.config.noMultiMutationCte) {
      response = await this.failDistributed(name, ids, outputData, table, db)
    } else {
      const sql = plans.failJobsById(this.config.schema, table)
      const result = await db.executeSql(sql, [name, ids, outputData])
      response = this.mapCommandResponse(ids, result)
    }

    this.#trackHandlerSettle(options, response)

    return response
  }

  private async failDistributed (name: string, ids: string[], outputData: any, table: string, db: types.IDatabase): Promise<types.CommandResponse> {
    // CockroachDB doesn't support multi-mutation CTEs, but does support transactions, so the
    // delete + re-insert is split into separate statements run atomically.
    return this.ensureTransaction(db, async (tx) => {
      // Step 1: Select jobs to fail
      const selectQuery = plans.selectJobsToFailById(this.config.schema, table)
      const { rows: jobs } = await tx.executeSql(selectQuery.text, [name, ids])

      if (jobs.length === 0) {
        return { jobs: ids, requested: ids.length, affected: 0, settled: [] }
      }

      // Step 2: Delete the jobs
      const deleteQuery = plans.deleteJobsToFail(this.config.schema, table)
      await tx.executeSql(deleteQuery.text, [name, ids])

      // Step 3: Re-insert jobs with updated state
      const count = await this.reinsertFailedJobs(tx, table, jobs, outputData)

      return { jobs: ids, requested: ids.length, affected: count, settled: jobs.map(job => job.id) }
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

  // Distributed flow audit for one partition table (CockroachDB / noMultiMutationCte): lock a
  // batch of completed blocking parents, then decrement their children and clear blocking per
  // parent queue (decrementDependents and clearBlocking are each keyed by a single name). Returns
  // the number of parents resolved so the resolver can loop until a batch drains.
  async resolveFlowJobsDistributed (table: string, names: string[]): Promise<number> {
    const select = plans.selectBlockingParents(this.config.schema, table, names, this.config.noSkipLocked)

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

      const decrementSql = plans.decrementDependents(this.config.schema)
      const clearSql = plans.clearBlocking(this.config.schema)

      for (const [name, ids] of idsByName) {
        await tx.executeSql(decrementSql, [name, ids])
        await tx.executeSql(clearSql, [name, ids])
      }

      return rows.length
    })
  }

  private async expireJobsDistributed (table: string, select: plans.SqlQuery, outputData: any): Promise<number> {
    return this.ensureTransaction(this.db, async (tx) => {
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
          const delay = Math.max(retryDelay, 1) * (Math.pow(2, exp) / 2 + Math.pow(2, exp) / 2 * Math.random())
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
          await tx.executeSql(dlqSql, [job.dead_letter, job.data, jobOutput, job.name, job.id, job.created_on, job.retry_count, job.singleton_key, job.priority, job.group_id, job.group_tier])
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
    const response = this.mapCommandResponse(ids, result)

    this.#trackHandlerSettle(options, response)

    return response
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
    const sql = plans.redriveJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, destination ?? null, sourceName ?? null, limit])
    return result.rows[0].moved as number
  }

  async cancel (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const { table } = await this.getQueueCache(name)

    const sql = plans.cancelJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    const response = this.mapCommandResponse(ids, result)

    this.#trackHandlerSettle(options, response)

    return response
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
    this.#evictQueueCache(name)
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

    // null is the documented way to clear the dead letter queue, so it has to reach the update as a
    // present-but-null key. Only a non-null value is a queue name worth validating.
    if (deadLetter !== null && deadLetter !== undefined) {
      Attorney.assertQueueName(deadLetter)
      notStrictEqual(name, deadLetter, 'deadLetter cannot be itself')
    }

    const sql = plans.updateQueue(this.config.schema)
    await this.db.executeSql(sql, [name, options])
    this.#evictQueueCache(name)
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

    const sql = plans.deleteQueue(this.config.schema, name, this.config.noAdvisoryLocks)
    await this.db.executeSql(sql)
    this.#evictQueueCache(name)
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
      const sql = plans.truncateTable(this.config.schema, plans.BASE_JOB_TABLE)
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

  // Queue stats are a time series, always returned as an array (newest first).
  //
  // With persistQueueStats enabled this returns the recorded history, optionally bounded by
  // from/to/limit. With it disabled there's no series, so it returns a single datapoint built from
  // the cached counts the monitor maintains on the queue table — cheap, and avoids re-running the
  // job-table aggregate on every call. The aggregate runs only when { force: true } is passed or the
  // cache is missing/stale; either way the fresh counts are written back to the cache so later reads
  // stay cheap. Throws if the queue doesn't exist. For the cached counts as a single value, use
  // getQueue(name).
  async getQueueStats (name: string, options: types.QueueStatsOptions = {}): Promise<types.QueueStats[]> {
    Attorney.assertQueueName(name)

    const isCockroach = this.config.backend === 'cockroachdb'

    const toSnapshot = (row: any): types.QueueStats => {
      const snapshot: types.QueueStats = {
        name,
        deferredCount: 0,
        queuedCount: 0,
        readyCount: 0,
        activeCount: 0,
        failedCount: 0,
        totalCount: 0,
        capturedOn: row?.capturedOn ?? new Date()
      }

      for (const field of STATS_COUNT_FIELDS) {
        const value = row?.[field]
        // CockroachDB returns integer columns as strings; normalize the counts.
        if (value !== undefined && value !== null) snapshot[field] = isCockroach ? Number(value) : value
      }

      return snapshot
    }

    if (this.config.persistQueueStats) {
      // Validate the queue exists (consistent with the persistence-off path below); the history
      // query itself would just return an empty series for an unknown name.
      await this.getQueueCache(name)

      const { from = null, to = null, limit = 1000, bucketSeconds, maxDataPoints, aggregate = 'max' } = options

      assert(Number.isInteger(limit) && limit >= 1 && limit <= 100_000,
        'getQueueStats: limit must be an integer between 1 and 100000')

      // Downsample into time buckets when requested. bucketSeconds sets an explicit resolution;
      // maxDataPoints derives the width in-SQL so the series fits in ~N points. Explicit wins.
      if (bucketSeconds !== undefined || maxDataPoints !== undefined) {
        assert(aggregate === 'max' || aggregate === 'min' || aggregate === 'avg',
          "getQueueStats: aggregate must be 'max', 'min', or 'avg'")

        const mode = bucketSeconds !== undefined ? 'bucket' : 'auto'
        const width = bucketSeconds ?? maxDataPoints

        assert(Number.isInteger(width) && width! >= 1,
          `getQueueStats: ${mode === 'bucket' ? 'bucketSeconds' : 'maxDataPoints'} must be a positive integer`)

        const sql = plans.getQueueStatsHistoryBucketed(this.config.schema, aggregate, mode)
        const { rows } = await this.db.executeSql(sql, [name, from, to, limit, width])

        return rows.map(toSnapshot)
      }

      const sql = plans.getQueueStatsHistory(this.config.schema)
      const { rows } = await this.db.executeSql(sql, [name, from, to, limit])

      return rows.map(toSnapshot)
    }

    // persistQueueStats disabled: serve the cached counts the monitor keeps on the queue table.
    // capturedOn is monitor_on — NULL if never monitored, or old if monitoring has since been turned
    // off. Serve the cache while it's within budget; otherwise recompute and re-cache. { force: true }
    // applies a much tighter budget (a fresh reading), but still reuses a value computed in the last
    // minute so repeated forced calls don't each re-run the aggregate.
    const cacheSql = plans.getQueueStatsCache(this.config.schema)
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

    // The vacuum-safety backoff outranks staleness, including a caller's { force: true }. Refreshing
    // here runs the same whole-job-table aggregate the supervisor just backed away from, and a
    // dashboard polling forced reads is exactly the "continuously running analytical query" shape
    // that pins the horizon. Serve the cache; capturedOn already tells the caller how old it is.
    //
    // Only when there is a cache to serve. A queue that has never been monitored carries a NULL
    // capturedOn and default-zero counts, and returning those would not be stale data - it would be
    // a fabricated answer of zero for a queue that may hold thousands of jobs. One first aggregate
    // per never-monitored queue is worth paying even under backoff.
    if (cached.monitorBackoff === true && cached.capturedOn != null) {
      return [toSnapshot(cached)]
    }

    if (cacheAgeMs <= maxCacheAgeMs) {
      return [toSnapshot(cached)]
    }

    // A queue with no capture yet has no cache to fall back on, so its first scan is exempt from the
    // try-lock — see refreshQueueStats. Every later read has real counts to serve and can lose.
    const refreshSql = plans.refreshQueueStats(this.config.schema, cached.table, name, {
      noAdvisoryLocks: this.config.noAdvisoryLocks,
      firstCapture: cached.capturedOn == null
    })
    const { rows: refreshed } = await this.db.executeSql(refreshSql)

    // No row means another instance is running this exact aggregate right now and won the try-lock.
    // Fall back to the cache rather than queueing behind it: waiting would hold the horizon for the
    // duration of someone else's scan to arrive at the counts that scan is about to write anyway.
    return [toSnapshot(refreshed.at(0) ?? cached)]
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
    Attorney.checkFindJobsArgs(options)

    const db = this.assertDb(options)

    const { table } = await this.getQueueCache(name)

    const { id, key, data, states, cursor, limit, direction, queued = false } = options

    // Anything that needs a defined order turns ordering on. A caller that asks for none of them
    // gets the unordered statement findJobs has always issued.
    const orderBy = (options.orderBy ?? (limit !== undefined || cursor !== undefined || direction !== undefined ? 'createdOn' : undefined))

    const sql = plans.findJobs(this.config.schema, table, {
      byId: id !== undefined,
      byKey: key !== undefined,
      byData: data !== undefined,
      byStates: states !== undefined,
      byCursor: cursor !== undefined,
      limited: limit !== undefined,
      orderBy,
      descending: direction === 'desc',
      queued
    })

    const values: unknown[] = [name]
    if (id !== undefined) values.push(id)
    if (key !== undefined) values.push(key)
    if (data !== undefined) values.push(JSON.stringify(data))
    if (states !== undefined) values.push(states)
    if (cursor !== undefined) values.push(cursor)
    if (limit !== undefined) values.push(limit)

    const result = await db.executeSql(sql, values)

    const rows = result?.rows || []

    // CockroachDB returns integer columns as strings; normalize them so a job read here has the
    // same shape as one from fetch() or getJobById().
    if (this.config.backend === 'cockroachdb') {
      for (const row of rows) {
        for (const field of NUMERIC_METADATA_FIELDS) {
          if (row[field] !== undefined && row[field] !== null) row[field] = Number(row[field])
        }
      }
    }

    return rows
  }

  // The singleton-key counterpart of getJobById. A key identifies a series rather than a row, so
  // this answers with the most recent one; pass `queued: true` for the job the key currently has
  // outstanding under a short/singleton/stately/exclusive policy.
  async getJobByKey<T>(name: string, key: string, options: types.GetJobByKeyOptions = {}): Promise<types.JobWithMetadata<T> | null> {
    assert(typeof key === 'string', 'getJobByKey() requires a singleton key')

    const { queued, db } = options

    const [job] = await this.findJobs<T>(name, {
      key,
      queued,
      db,
      limit: 1,
      orderBy: 'createdOn',
      direction: 'desc'
    })

    return job ?? null
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
