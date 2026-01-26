import assert, { notStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import { serializeError as stringify } from 'serialize-error'
import * as Attorney from './attorney.ts'
import type Db from './db.ts'
import * as plans from './plans.ts'
import type Timekeeper from './timekeeper.ts'
import * as timekeeper from './timekeeper.ts'
import { resolveWithinSeconds } from './tools.ts'
import * as types from './types.ts'
import Worker from './worker.ts'
import { JobSpy, type JobSpyInterface } from './spy.ts'

const INTERNAL_QUEUES = Object.values(timekeeper.QUEUES).reduce<Record<string, string | undefined>>((acc, i) => ({ ...acc, [i]: i }), {})

const events = {
  error: 'error',
  wip: 'wip'
}

class Manager extends EventEmitter implements types.EventsMixin {
  events = events
  db: (types.IDatabase & { _pgbdb?: false }) | Db
  config: types.ResolvedConstructorOptions
  wipTs: number
  workers: Map<string, Worker>
  stopped: boolean | undefined
  queueCacheInterval: NodeJS.Timeout | undefined
  timekeeper: Timekeeper | undefined
  queues: Record<string, types.QueueResult> | null
  pendingOffWorkCleanups: Set<Promise<any>>
  #spies: Map<string, JobSpy>
  #localGroupActive: Map<string, Map<string, number>>
  #localGroupConfig: Map<string, types.GroupConcurrencyConfig>

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    super()

    this.config = config
    this.db = db
    this.wipTs = Date.now()
    this.workers = new Map()
    this.queues = null
    this.pendingOffWorkCleanups = new Set()
    this.#spies = new Map()
    this.#localGroupActive = new Map()
    this.#localGroupConfig = new Map()
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

    const atCapacity: string[] = []
    for (const [groupId, activeCount] of queueGroups.entries()) {
      // We don't have tier info here, so use default limit
      // Jobs with tiers will be checked individually after fetch
      const limit = config.default
      if (activeCount >= limit) {
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

  #trackJobsCompleted<T> (name: string, jobs: types.Job<T>[], result: unknown): void {
    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined
    if (spy) {
      const output = jobs.length === 1 ? result as object : undefined
      for (const job of jobs) {
        spy.addJob(job.id, name, job.data as object, 'completed', output)
      }
    }
  }

  #trackJobsFailed<T> (name: string, jobs: types.Job<T>[], err: Error): void {
    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined
    if (spy) {
      for (const job of jobs) {
        spy.addJob(job.id, name, job.data as object, 'failed', { message: err?.message, stack: err?.stack })
      }
    }
  }

  #storeLocalGroupConfig (name: string, localGroupConcurrency: number | types.GroupConcurrencyConfig): void {
    const config: types.GroupConcurrencyConfig = typeof localGroupConcurrency === 'number'
      ? { default: localGroupConcurrency }
      : localGroupConcurrency
    this.#localGroupConfig.set(name, config)
  }

  #cleanupLocalGroupTracking (name: string): void {
    // Only cleanup if no more workers exist for this queue
    const hasWorkersForQueue = this.getWorkers().some(w => w.name === name && !w.stopping && !w.stopped)
    if (!hasWorkersForQueue) {
      this.#localGroupConfig.delete(name)
      this.#localGroupActive.delete(name)
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
    worker?: Worker<T>
  ): Promise<void> {
    const jobIds = jobs.map(job => job.id)
    const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expireInSeconds), 0)
    const ac = new AbortController()
    jobs.forEach(job => { job.signal = ac.signal })

    // Store AbortController on worker so it can be aborted after graceful shutdown
    if (worker) {
      worker.abortController = ac
    }

    try {
      const result = await resolveWithinSeconds(callback(jobs), maxExpiration, `handler execution exceeded ${maxExpiration}s`, ac)
      await this.complete(name, jobIds, jobIds.length === 1 ? result : undefined)
      this.#trackJobsCompleted(name, jobs, result)
    } catch (err: any) {
      await this.fail(name, jobIds, err)
      this.#trackJobsFailed(name, jobs, err)
    } finally {
      if (worker) {
        // Clear between jobs
        worker.abortController = null
      }
    }
  }

  async start () {
    this.stopped = false
    this.queueCacheInterval = setInterval(() => this.onCacheQueues({ emit: true }), this.config.queueCacheIntervalSeconds! * 1000)
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

    await Promise.allSettled(
      [...this.workers.values()]
        .filter(worker => !INTERNAL_QUEUES[worker.name])
        .map(async worker => await this.offWork(worker.name, { wait: false }))
    )

    // Clean up all local group tracking on full stop
    this.#localGroupConfig.clear()
    this.#localGroupActive.clear()
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
  work<ReqData>(name: string, options: types.WorkOptions & { includeMetadata: true }, handler: types.WorkWithMetadataHandler<ReqData>): Promise<string>
  work<ReqData>(name: string, options: types.WorkOptions, handler: types.WorkHandler<ReqData>): Promise<string>
  async work<ReqData> (name: string, ...args: unknown[]): Promise<string> {
    const { options, callback } = Attorney.checkWorkArgs(name, args)

    if (this.stopped) {
      throw new Error('Workers are disabled. pg-boss is stopped')
    }

    const {
      pollingInterval: interval,
      batchSize = 1,
      includeMetadata = false,
      priority = true,
      localConcurrency = 1,
      localGroupConcurrency,
      groupConcurrency,
      orderByCreatedOn = true
    } = options

    if (localGroupConcurrency != null) {
      this.#storeLocalGroupConfig(name, localGroupConcurrency)
    }

    const firstWorkerId = randomUUID({ disableEntropyCache: true })

    const createWorker = (workerId: string) => {
      const fetch = () => {
        const ignoreGroups = localGroupConcurrency != null
          ? this.#getGroupsAtLocalCapacity(name)
          : undefined
        return this.fetch<ReqData>(name, { batchSize, includeMetadata, priority, groupConcurrency, ignoreGroups })
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
          await this.#processJobs(name, jobs, callback, worker)
        } else {
          const { allowed, excess, groupedJobs } = this.#trackLocalGroupStart(name, jobs)

          if (excess.length > 0) {
            const excessIds = excess.map(job => job.id)
            await this.restore(name, excessIds)
          }

          if (allowed.length > 0) {
            try {
              await this.#processJobs(name, allowed, callback, worker)
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

      return new Worker<ReqData>({ id: workerId, name, options, interval, fetch, onFetch, onError })
    }

    // Spawn workers based on localConcurrency setting
    for (let i = 0; i < localConcurrency; i++) {
      const workerId = i === 0 ? firstWorkerId : randomUUID({ disableEntropyCache: true })
      const worker = createWorker(workerId)

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
      group
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
      retryDelayMax
    }

    const db = wrapper || this.db

    const { table } = await this.getQueueCache(name)

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId: true })

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

  async insert (name: string, jobs: types.JobInsert[], options: types.InsertOptions = {}) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const { table } = await this.getQueueCache(name)

    const db = this.assertDb(options)

    const spy = this.config.__test__enableSpies ? this.#spies.get(name) : undefined

    // Return IDs if spy is active for this queue (needed for job tracking)
    const returnId = !!spy

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId })

    const { rows } = await db.executeSql(sql, [JSON.stringify(jobs)])

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

    const query = plans.fetchNextJob(fetchOptions)

    let result

    try {
      result = await db.executeSql(query.text, query.values)
    } catch (err) {
      // errors from fetchquery should only be unique constraint violations
    }

    return result?.rows || []
  }

  private mapCompletionIdArg (id: string | string[], funcName: string) {
    const errorMessage = `${funcName}() requires an id`

    assert(id, errorMessage)

    const ids = Array.isArray(id) ? id : [id]

    assert(ids.length, errorMessage)

    return ids
  }

  private mapCompletionDataArg (data?: object | null) {
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

  async complete (name: string, id: string | string[], data?: object | null, options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'complete')
    const { table } = await this.getQueueCache(name)
    const sql = plans.completeJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
  }

  async fail (name: string, id: string | string[], data?: any, options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'fail')
    const { table } = await this.getQueueCache(name)
    const sql = plans.failJobsById(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
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

    const sql = plans.createQueue(this.config.schema, name, { ...options, policy })
    await this.db.executeSql(sql)
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
    Attorney.assertQueueName(name)

    const query = plans.getQueues(this.config.schema, [name])
    const { rows } = await this.db.executeSql(query.text, query.values)

    return rows[0] || null
  }

  async deleteQueue (name: string) {
    Attorney.assertQueueName(name)

    try {
      await this.getQueueCache(name)
      const sql = plans.deleteQueue(this.config.schema, name)
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

    return Object.assign(queue, rows.at(0) ||
            {
              deferredCount: 0,
              queuedCount: 0,
              activeCount: 0,
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
      return result1.rows[0]
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
