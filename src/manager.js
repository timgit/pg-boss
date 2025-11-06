const assert = require('node:assert')
const EventEmitter = require('node:events')
const { randomUUID } = require('node:crypto')
const { serializeError: stringify } = require('serialize-error')
const { delay, resolveWithinSeconds } = require('./tools')
const Attorney = require('./attorney')
const Worker = require('./worker')
const plans = require('./plans')

const { QUEUES: TIMEKEEPER_QUEUES } = require('./timekeeper')
const { QUEUE_POLICIES } = plans

const INTERNAL_QUEUES = Object.values(TIMEKEEPER_QUEUES).reduce((acc, i) => ({ ...acc, [i]: i }), {})

const events = {
  error: 'error',
  wip: 'wip'
}

class Manager extends EventEmitter {
  constructor (db, config) {
    super()

    this.config = config
    this.db = db
    this.wipTs = Date.now()
    this.workers = new Map()
    this.queues = null

    this.events = events
    this.functions = [
      this.complete,
      this.cancel,
      this.resume,
      this.retry,
      this.fail,
      this.fetch,
      this.work,
      this.offWork,
      this.notifyWorker,
      this.publish,
      this.subscribe,
      this.unsubscribe,
      this.insert,
      this.send,
      this.sendDebounced,
      this.sendThrottled,
      this.sendAfter,
      this.createQueue,
      this.updateQueue,
      this.deleteQueue,
      this.getQueueStats,
      this.getQueue,
      this.getQueues,
      this.deleteQueuedJobs,
      this.deleteStoredJobs,
      this.deleteAllJobs,
      this.deleteJob,
      this.getJobById,
      this.getJobsByData
    ]
  }

  async start () {
    this.stopped = false
    this.queueCacheInterval = setInterval(() => this.onCacheQueues({ emit: true }), this.config.queueCacheIntervalSeconds * 1000)
    await this.onCacheQueues()
  }

  async onCacheQueues ({ emit = false } = {}) {
    try {
      assert(!this.config.__test__throw_queueCache, 'test error')
      const queues = await this.getQueues()
      this.queues = queues.reduce((acc, i) => { acc[i.name] = i; return acc }, {})
    } catch (error) {
      emit && this.emit(events.error, { ...error, message: error.message, stack: error.stack })
    }
  }

  async getQueueCache (name) {
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

    for (const worker of this.workers.values()) {
      if (!INTERNAL_QUEUES[worker.name]) {
        await this.offWork(worker.name)
      }
    }
  }

  async failWip () {
    for (const worker of this.workers.values()) {
      const jobIds = worker.jobs.map(j => j.id)
      if (jobIds.length) {
        await this.fail(worker.name, jobIds, 'pg-boss shut down while active')
      }
    }
  }

  async work (name, ...args) {
    const { options, callback } = Attorney.checkWorkArgs(name, args)
    return await this.watch(name, options, callback)
  }

  addWorker (worker) {
    this.workers.set(worker.id, worker)
  }

  removeWorker (worker) {
    this.workers.delete(worker.id)
  }

  getWorkers () {
    return Array.from(this.workers.values())
  }

  emitWip (name) {
    if (!INTERNAL_QUEUES[name]) {
      const now = Date.now()

      if (now - this.wipTs > 2000) {
        this.emit(events.wip, this.getWipData())
        this.wipTs = now
      }
    }
  }

  getWipData (options = {}) {
    const { includeInternal = false } = options

    const data = this.getWorkers()
      .map(({
        id,
        name,
        options,
        state,
        jobs,
        createdOn,
        lastFetchedOn,
        lastJobStartedOn,
        lastJobEndedOn,
        lastError,
        lastErrorOn
      }) => ({
        id,
        name,
        options,
        state,
        count: jobs.length,
        createdOn,
        lastFetchedOn,
        lastJobStartedOn,
        lastJobEndedOn,
        lastError,
        lastErrorOn
      }))
      .filter(i => i.count > 0 && (!INTERNAL_QUEUES[i.name] || includeInternal))

    return data
  }

  async watch (name, options, callback) {
    if (this.stopped) {
      throw new Error('Workers are disabled. pg-boss is stopped')
    }

    const {
      pollingInterval: interval = this.config.pollingInterval,
      batchSize,
      includeMetadata = false,
      priority = true
    } = options

    const id = randomUUID({ disableEntropyCache: true })

    const fetch = () => this.fetch(name, { batchSize, includeMetadata, priority })

    const onFetch = async (jobs) => {
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
      } catch (err) {
        await this.fail(name, jobIds, err)
      }

      this.emitWip(name)
    }

    const onError = error => {
      this.emit(events.error, { ...error, message: error.message, stack: error.stack, queue: name, worker: id })
    }

    const worker = new Worker({ id, name, options, interval, fetch, onFetch, onError })

    this.addWorker(worker)

    worker.start()

    return id
  }

  async offWork (value) {
    assert(value, 'Missing required argument')

    const query = (typeof value === 'string')
      ? { filter: i => i.name === value }
      : (typeof value === 'object' && value.id)
          ? { filter: i => i.id === value.id }
          : null

    assert(query, 'Invalid argument. Expected string or object: { id }')

    const workers = this.getWorkers().filter(i => query.filter(i) && !i.stopping && !i.stopped)

    if (workers.length === 0) {
      return
    }

    for (const worker of workers) {
      worker.stop()
    }

    setImmediate(async () => {
      while (!workers.every(w => w.stopped)) {
        await delay(1000)
      }

      for (const worker of workers) {
        this.removeWorker(worker)
      }
    })
  }

  notifyWorker (workerId) {
    if (this.workers.has(workerId)) {
      this.workers.get(workerId).notify()
    }
  }

  async subscribe (event, name) {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')
    const sql = plans.subscribe(this.config.schema)
    return await this.db.executeSql(sql, [event, name])
  }

  async unsubscribe (event, name) {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')
    const sql = plans.unsubscribe(this.config.schema)
    return await this.db.executeSql(sql, [event, name])
  }

  async publish (event, ...args) {
    assert(event, 'Missing required argument')
    const sql = plans.getQueuesForEvent(this.config.schema)
    const { rows } = await this.db.executeSql(sql, [event])

    await Promise.allSettled(rows.map(({ name }) => this.send(name, ...args)))
  }

  async send (...args) {
    const { name, data, options } = Attorney.checkSendArgs(args)

    return await this.createJob(name, data, options)
  }

  async sendAfter (name, data, options, after) {
    options = options ? { ...options } : {}
    options.startAfter = after

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendThrottled (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendDebounced (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options])

    return await this.createJob(result.name, result.data, result.options)
  }

  async createJob (name, data, options) {
    const singletonOffset = 0

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
      singletonOffset,
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
      job.startAfter = this.getDebounceStartAfter(singletonSeconds, this.timekeeper.clockSkew)
      job.singletonOffset = singletonSeconds

      const { rows: try2 } = await db.executeSql(sql, [JSON.stringify([job])])

      if (try2.length === 1) {
        return try2[0].id
      }
    }

    return null
  }

  async insert (name, jobs, options = {}) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const { table } = await this.getQueueCache(name)

    const db = this.assertDb(options)

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId: false })

    const { rows } = await db.executeSql(sql, [JSON.stringify(jobs)])

    return (rows.length) ? rows.map(i => i.id) : null
  }

  getDebounceStartAfter (singletonSeconds, clockOffset) {
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

  async fetch (name, options = {}) {
    Attorney.checkFetchArgs(name, options)

    const db = this.assertDb(options)

    const { table, policy, singletonsActive } = await this.getQueueCache(name)

    options = {
      ...options,
      schema: this.config.schema,
      table,
      name,
      policy,
      limit: options.batchSize,
      ignoreSingletons: singletonsActive
    }

    const sql = plans.fetchNextJob(options)

    let result

    try {
      result = await db.executeSql(sql)
    } catch (err) {
      // errors from fetchquery should only be unique constraint violations
    }

    return result?.rows || []
  }

  mapCompletionIdArg (id, funcName) {
    const errorMessage = `${funcName}() requires an id`

    assert(id, errorMessage)

    const ids = Array.isArray(id) ? id : [id]

    assert(ids.length, errorMessage)

    return ids
  }

  mapCompletionDataArg (data) {
    if (data === null || typeof data === 'undefined' || typeof data === 'function') { return null }

    const result = (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value: data }

    return stringify(result)
  }

  mapCommandResponse (ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      affected: result && result.rows ? parseInt(result.rows[0].count) : 0
    }
  }

  async complete (name, id, data, options = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'complete')
    const { table } = await this.getQueueCache(name)
    const sql = plans.completeJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
  }

  async fail (name, id, data, options = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'fail')
    const { table } = await this.getQueueCache(name)
    const sql = plans.failJobsById(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
  }

  async cancel (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const { table } = await this.getQueueCache(name)
    const sql = plans.cancelJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async deleteJob (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'deleteJob')
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteJobsById(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async resume (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = this.assertDb(options)
    const ids = this.mapCompletionIdArg(id, 'resume')
    const { table } = await this.getQueueCache(name)
    const sql = plans.resumeJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async retry (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'retry')
    const { table } = await this.getQueueCache(name)
    const sql = plans.retryJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async createQueue (name, options = {}) {
    name = name || options.name

    Attorney.assertQueueName(name)

    options.policy = options.policy || QUEUE_POLICIES.standard

    assert(options.policy in QUEUE_POLICIES, `${options.policy} is not a valid queue policy`)

    Attorney.validateQueueArgs(options)

    if (options.deadLetter) {
      Attorney.assertQueueName(options.deadLetter)
      assert.notStrictEqual(name, options.deadLetter, 'deadLetter cannot be itself')
      await this.getQueueCache(options.deadLetter)
    }

    const sql = plans.createQueue(this.config.schema, name, options)
    await this.db.executeSql(sql)
  }

  async getQueues (names) {
    if (names) {
      names = Array.isArray(names) ? names : [names]
      for (const name of names) {
        Attorney.assertQueueName(name)
      }
    }

    const sql = plans.getQueues(this.config.schema, names)
    const { rows } = await this.db.executeSql(sql)
    return rows
  }

  async updateQueue (name, options = {}) {
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
      assert.notStrictEqual(name, deadLetter, 'deadLetter cannot be itself')
    }

    const sql = plans.updateQueue(this.config.schema, { deadLetter })
    await this.db.executeSql(sql, [name, options])
  }

  async getQueue (name) {
    Attorney.assertQueueName(name)

    const sql = plans.getQueues(this.config.schema, [name])
    const { rows } = await this.db.executeSql(sql)

    return rows[0] || null
  }

  async deleteQueue (name) {
    Attorney.assertQueueName(name)

    try {
      await this.getQueueCache(name)
      const sql = plans.deleteQueue(this.config.schema, name)
      await this.db.executeSql(sql)
    } catch {}
  }

  async deleteQueuedJobs (name) {
    Attorney.assertQueueName(name)
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteQueuedJobs(this.config.schema, table)
    await this.db.executeSql(sql, [name])
  }

  async deleteStoredJobs (name) {
    Attorney.assertQueueName(name)
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteStoredJobs(this.config.schema, table)
    await this.db.executeSql(sql, [name])
  }

  async deleteAllJobs (name) {
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

  async getQueueStats (name) {
    Attorney.assertQueueName(name)

    const queue = await this.getQueueCache(name)

    const sql = plans.getQueueStats(this.config.schema, queue.table, [name])

    const { rows } = await this.db.executeSql(sql)

    return Object.assign(queue, rows.at(0) || {})
  }

  async getJobById (name, id, options = {}) {
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

  async getJobsByData (name, data, options = {}) {
    const { onlyQueued = true } = options

    Attorney.assertQueueName(name)

    const db = this.assertDb(options)

    const { table } = await this.getQueueCache(name)

    const sql = plans.getJobsByData(this.config.schema, table, onlyQueued)

    const result = await db.executeSql(sql, [name, data])

    return result.rows
  }

  assertDb (options) {
    if (options.db) {
      return options.db
    }

    if (this.db._pgbdb) {
      assert(this.db.opened, 'Database connection is not opened')
    }

    return this.db
  }
}

module.exports = Manager
