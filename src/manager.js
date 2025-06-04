const assert = require('node:assert')
const EventEmitter = require('node:events')
const { randomUUID } = require('node:crypto')
const { serializeError: stringify } = require('serialize-error')
const { delay } = require('./tools')
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

const resolveWithinSeconds = async (promise, seconds) => {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay(timeout, `handler execution exceeded ${timeout}ms`)

  let result

  try {
    result = await Promise.race([promise, reject])
  } finally {
    reject.abort()
  }

  return result
}

class Manager extends EventEmitter {
  constructor (db, config) {
    super()

    this.config = config
    this.db = db

    this.events = events
    this.wipTs = Date.now()
    this.workers = new Map()

    this.nextJobCommand = plans.fetchNextJob(config.schema)
    this.insertJobCommand = plans.insertJob(config.schema)
    this.insertJobsCommand = plans.insertJobs(config.schema)
    this.completeJobsCommand = plans.completeJobs(config.schema)
    this.cancelJobsCommand = plans.cancelJobs(config.schema)
    this.resumeJobsCommand = plans.resumeJobs(config.schema)
    this.deleteJobsCommand = plans.deleteJobs(config.schema)
    this.retryJobsCommand = plans.retryJobs(config.schema)
    this.failJobsByIdCommand = plans.failJobsById(config.schema)
    this.getJobByIdCommand = plans.getJobById(config.schema)
    this.getArchivedJobByIdCommand = plans.getArchivedJobById(config.schema)
    this.subscribeCommand = plans.subscribe(config.schema)
    this.unsubscribeCommand = plans.unsubscribe(config.schema)
    this.getQueuesCommand = plans.getQueues(config.schema)
    this.getQueueByNameCommand = plans.getQueueByName(config.schema)
    this.getQueuesForEventCommand = plans.getQueuesForEvent(config.schema)
    this.createQueueCommand = plans.createQueue(config.schema)
    this.updateQueueCommand = plans.updateQueue(config.schema)
    this.purgeQueueCommand = plans.purgeQueue(config.schema)
    this.deleteQueueCommand = plans.deleteQueue(config.schema)
    this.clearStorageCommand = plans.clearStorage(config.schema)

    // exported api to index
    this.functions = [
      this.complete,
      this.cancel,
      this.resume,
      this.retry,
      this.deleteJob,
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
      this.purgeQueue,
      this.getQueueSize,
      this.getQueue,
      this.getQueues,
      this.clearStorage,
      this.getJobById
    ]
  }

  start () {
    this.stopped = false
  }

  async stop () {
    this.stopped = true

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
    const { options, callback } = Attorney.checkWorkArgs(name, args, this.config)
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
        const result = await resolveWithinSeconds(callback(jobs), maxExpiration)
        this.complete(name, jobIds, jobIds.length === 1 ? result : undefined)
      } catch (err) {
        this.fail(name, jobIds, err)
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

    return await this.db.executeSql(this.subscribeCommand, [event, name])
  }

  async unsubscribe (event, name) {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')

    return await this.db.executeSql(this.unsubscribeCommand, [event, name])
  }

  async publish (event, ...args) {
    assert(event, 'Missing required argument')

    const { rows } = await this.db.executeSql(this.getQueuesForEventCommand, [event])

    await Promise.allSettled(rows.map(({ name }) => this.send(name, ...args)))
  }

  async send (...args) {
    const { name, data, options } = Attorney.checkSendArgs(args, this.config)
    return await this.createJob(name, data, options)
  }

  async sendAfter (name, data, options, after) {
    options = options ? { ...options } : {}
    options.startAfter = after

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendThrottled (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendDebounced (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async createJob (name, data, options, singletonOffset = 0) {
    const {
      id = null,
      db: wrapper,
      priority,
      startAfter,
      singletonKey = null,
      singletonSeconds,
      deadLetter = null,
      expireIn,
      expireInDefault,
      keepUntil,
      keepUntilDefault,
      retryLimit,
      retryLimitDefault,
      retryDelay,
      retryDelayDefault,
      retryBackoff,
      retryBackoffDefault
    } = options

    const values = [
      id, // 1
      name, // 2
      data, // 3
      priority, // 4
      startAfter, // 5
      singletonKey, // 6
      singletonSeconds, // 7
      singletonOffset, // 8
      deadLetter, // 9
      expireIn, // 10
      expireInDefault, // 11
      keepUntil, // 12
      keepUntilDefault, // 13
      retryLimit, // 14
      retryLimitDefault, // 15
      retryDelay, // 16
      retryDelayDefault, // 17
      retryBackoff, // 18
      retryBackoffDefault // 19
    ]

    const db = wrapper || this.db
    const { rows } = await db.executeSql(this.insertJobCommand, values)

    if (rows.length === 1) {
      return rows[0].id
    }

    if (!options.singletonNextSlot) {
      return null
    }

    // delay starting by the offset to honor throttling config
    options.startAfter = this.getDebounceStartAfter(singletonSeconds, this.timekeeper.clockSkew)

    // toggle off next slot config for round 2
    options.singletonNextSlot = false

    singletonOffset = singletonSeconds

    return await this.createJob(name, data, options, singletonOffset)
  }

  async insert (jobs, options = {}) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const db = options.db || this.db

    const params = [
      JSON.stringify(jobs), // 1
      this.config.expireIn, // 2
      this.config.keepUntil, // 3
      this.config.retryLimit, // 4
      this.config.retryDelay, // 5
      this.config.retryBackoff // 6
    ]

    const { rows } = await db.executeSql(this.insertJobsCommand, params)

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
    const db = options.db || this.db
    const nextJobSql = this.nextJobCommand({ ...options })

    let result

    try {
      result = await db.executeSql(nextJobSql, [name, options.batchSize])
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
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'complete')
    const result = await db.executeSql(this.completeJobsCommand, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
  }

  async fail (name, id, data, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'fail')
    const result = await db.executeSql(this.failJobsByIdCommand, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
  }

  async cancel (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const result = await db.executeSql(this.cancelJobsCommand, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async deleteJob (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'deleteJob')
    const result = await db.executeSql(this.deleteJobsCommand, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async resume (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'resume')
    const result = await db.executeSql(this.resumeJobsCommand, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async retry (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'retry')
    const result = await db.executeSql(this.retryJobsCommand, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async createQueue (name, options = {}) {
    name = name || options.name

    Attorney.assertQueueName(name)

    const { policy = QUEUE_POLICIES.standard } = options

    assert(policy in QUEUE_POLICIES, `${policy} is not a valid queue policy`)

    const {
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    } = Attorney.checkQueueArgs(name, options)

    if (deadLetter) {
      Attorney.assertQueueName(deadLetter)
    }

    // todo: pull in defaults from constructor config
    const data = {
      policy,
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    }

    await this.db.executeSql(this.createQueueCommand, [name, data])
  }

  async getQueues () {
    const { rows } = await this.db.executeSql(this.getQueuesCommand)
    return rows
  }

  async updateQueue (name, options = {}) {
    Attorney.assertQueueName(name)

    const { policy = QUEUE_POLICIES.standard } = options

    assert(policy in QUEUE_POLICIES, `${policy} is not a valid queue policy`)

    const {
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    } = Attorney.checkQueueArgs(name, options)

    const params = [
      name,
      policy,
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    ]

    await this.db.executeSql(this.updateQueueCommand, params)
  }

  async getQueue (name) {
    Attorney.assertQueueName(name)

    const { rows } = await this.db.executeSql(this.getQueueByNameCommand, [name])

    return rows[0] || null
  }

  async deleteQueue (name) {
    Attorney.assertQueueName(name)

    const { rows } = await this.db.executeSql(this.getQueueByNameCommand, [name])

    if (rows.length === 1) {
      await this.db.executeSql(this.deleteQueueCommand, [name])
    }
  }

  async purgeQueue (name) {
    Attorney.assertQueueName(name)
    await this.db.executeSql(this.purgeQueueCommand, [name])
  }

  async clearStorage () {
    await this.db.executeSql(this.clearStorageCommand)
  }

  async getQueueSize (name, options) {
    Attorney.assertQueueName(name)

    const sql = plans.getQueueSize(this.config.schema, options)

    const result = await this.db.executeSql(sql, [name])

    return result ? parseFloat(result.rows[0].count) : null
  }

  async getJobById (name, id, options = {}) {
    Attorney.assertQueueName(name)

    const db = options.db || this.db

    const result1 = await db.executeSql(this.getJobByIdCommand, [name, id])

    if (result1?.rows?.length === 1) {
      return result1.rows[0]
    } else if (options.includeArchive) {
      const result2 = await db.executeSql(this.getArchivedJobByIdCommand, [name, id])
      return result2?.rows[0] || null
    } else {
      return null
    }
  }
}

module.exports = Manager
