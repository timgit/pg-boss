import assert, { notStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import { serializeError as stringify } from 'serialize-error'
import * as Attorney from './attorney.ts'
import type Db from './db.ts'
import * as plans from './plans.ts'
import type Timekeeper from './timekeeper.ts'
import * as timekeeper from './timekeeper.ts'
import { delay, resolveWithinSeconds } from './tools.ts'
import * as types from './types.ts'
import Worker from './worker.ts'

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

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    super()

    this.config = config
    this.db = db
    this.wipTs = Date.now()
    this.workers = new Map()
    this.queues = null
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
  }

  async failWip () {
    for (const worker of this.workers.values()) {
      const jobIds = worker.jobs.map(j => j.id)
      if (jobIds.length) {
        console.log(`Failing ${jobIds.length} active jobs in worker ${worker.id} for queue ${worker.name}`)
        await this.fail(worker.name, jobIds, 'pg-boss shut down while active')
      }
    }
  }

  work<ReqData>(name: string, handler: types.WorkHandler<ReqData>): Promise<string>
  work<ReqData>(name: string, options: types.WorkOptions & { includeMetadata: true }, handler: types.WorkWithMetadataHandler<ReqData>): Promise<string>
  work<ReqData>(name: string, options: types.WorkOptions, handler: types.WorkHandler<ReqData>): Promise<string>
  async work (name: string, ...args: unknown[]): Promise<string> {
    const { options, callback } = Attorney.checkWorkArgs(name, args)
    return await this.watch(name, options, callback)
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
      .filter(i => i.count > 0 && (!INTERNAL_QUEUES[i.name] || includeInternal))

    return data
  }

  private async watch<T> (name: string, options: types.ResolvedWorkOptions, callback: types.WorkHandler<T>): Promise<string> {
    if (this.stopped) {
      throw new Error('Workers are disabled. pg-boss is stopped')
    }

    const {
      pollingInterval: interval,
      batchSize,
      includeMetadata = false,
      priority = true
    } = options

    const id = randomUUID({ disableEntropyCache: true })

    const fetch = () => this.fetch<T>(name, { batchSize, includeMetadata, priority })

    const onFetch = async (jobs: types.Job<T>[]) => {
      if (!jobs.length) {
        return
      }

      if (this.config.__test__throw_worker) {
        throw new Error('__test__throw_worker')
      }

      this.emitWip(name)

      const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expireInSeconds), 0)
      const jobIds = jobs.map(job => job.id)

      try {
        const result = await resolveWithinSeconds(callback(jobs), maxExpiration, `handler execution exceeded ${maxExpiration}s`)
        await this.complete(name, jobIds, jobIds.length === 1 ? result : undefined)
      } catch (err: any) {
        await this.fail(name, jobIds, err)
      }

      this.emitWip(name)
    }

    const onError = (error: any) => {
      this.emit(events.error, { ...error, message: error.message, stack: error.stack, queue: name, worker: id })
    }

    const worker = new Worker<T>({ id, name, options, interval, fetch, onFetch, onError })

    this.addWorker(worker)

    worker.start()

    return id
  }

  async offWork (name: string, options: types.OffWorkOptions = { wait: true }): Promise<void> {
    assert(name, 'queue name is required')
    assert(typeof name === 'string', 'queue name must be a string')

    const query = (i: Worker<any>) => options?.id ? i.id === options.id : i.name === name

    const workers = this.getWorkers().filter(i => query(i) && !i.stopping && !i.stopped)

    if (workers.length === 0) {
      return
    }

    for (const worker of workers) {
      worker.stop()
    }

    const finish = async () => {
      while (!workers.every(w => w.stopped)) {
        await delay(1000)
      }

      for (const worker of workers) {
        this.removeWorker(worker)
      }
    }

    if (options.wait) {
      await finish()
    } else {
      setImmediate(async () => {
        await finish()
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
  send (name: string, data?: object | null, options?: types.SendOptions): Promise<string | null>
  async send (...args: any[]): Promise<string | null> {
    const result = Attorney.checkSendArgs(args)

    return await this.createJob(result)
  }

  async sendAfter (name: string, data: object, options: types.SendOptions, after: Date | string | number): Promise<string | null> {
    options = options ? { ...options } : {}
    options.startAfter = after

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result)
  }

  async sendThrottled (name: string, data: object, options: types.SendOptions, seconds: number, key?: string): Promise<string | null> {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result)
  }

  async sendDebounced (name: string, data: object, options: types.SendOptions, seconds: number, key?: string): Promise<string | null> {
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
      retryDelayMax
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
      return try1[0].id
    }

    if (singletonNextSlot) {
      // delay starting by the offset to honor throttling config
      job.startAfter = this.getDebounceStartAfter(singletonSeconds!, this.timekeeper!.clockSkew)
      job.singletonOffset = singletonSeconds

      const { rows: try2 } = await db.executeSql(sql, [JSON.stringify([job])])

      if (try2.length === 1) {
        return try2[0].id
      }
    }

    return null
  }

  async insert (name: string, jobs: types.JobInsert[], options: types.InsertOptions = {}) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const { table } = await this.getQueueCache(name)

    const db = this.assertDb(options)

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId: false })

    const { rows } = await db.executeSql(sql, [JSON.stringify(jobs)])

    return (rows.length) ? rows.map((i): string => i.id) : null
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
      limit: options.batchSize!,
      ignoreSingletons: singletonsActive
    }

    const sql = plans.fetchNextJob(fetchOptions)

    let result

    try {
      result = await db.executeSql(sql)
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

  private mapCompletionDataArg (data: object | undefined) {
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

  async complete (name: string, id: string | string[], data?: object, options: types.ConnectionOptions = {}) {
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

  async cancel (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const { table } = await this.getQueueCache(name)
    const sql = plans.cancelJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
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

  async resume (name: string, id: string | string[], options: types.ConnectionOptions = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'resume')
    const { table } = await this.getQueueCache(name)
    const sql = plans.resumeJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
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

    options.policy = options.policy || plans.QUEUE_POLICIES.standard

    assert(options.policy in plans.QUEUE_POLICIES, `${options.policy} is not a valid queue policy`)

    Attorney.validateQueueArgs(options)

    if (options.deadLetter) {
      Attorney.assertQueueName(options.deadLetter)
      notStrictEqual(name, options.deadLetter, 'deadLetter cannot be itself')
      await this.getQueueCache(options.deadLetter)
    }

    const sql = plans.createQueue(this.config.schema, name, options)
    await this.db.executeSql(sql)
  }

  async getQueues (names?: string | string[]): Promise<types.QueueResult[]> {
    names = Array.isArray(names) ? names : typeof names === 'string' ? [names] : undefined
    if (names) {
      for (const name of names) {
        Attorney.assertQueueName(name)
      }
    }

    const sql = plans.getQueues(this.config.schema, names)
    const { rows } = await this.db.executeSql(sql)
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

    const sql = plans.getQueues(this.config.schema, [name])
    const { rows } = await this.db.executeSql(sql)

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

  async deleteAllJobs (name: string) {
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

    const sql = plans.getQueueStats(this.config.schema, queue.table, [name])

    const { rows } = await this.db.executeSql(sql)

    return Object.assign(queue, rows.at(0) || {})
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
