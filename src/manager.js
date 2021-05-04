const assert = require('assert')
const EventEmitter = require('events')
const pMap = require('p-map')
const delay = require('delay')
const uuid = require('uuid')
const debounce = require('lodash.debounce')

const Attorney = require('./attorney')
const Worker = require('./worker')

const { QUEUES: BOSS_QUEUES } = require('./boss')
const HIDDEN_QUEUES = Object.values(BOSS_QUEUES)

// todo: add cron and send it queues to ignore list

const plans = require('./plans')
const { COMPLETION_JOB_PREFIX, SINGLETON_QUEUE_KEY } = plans

const WIP_EVENT_INTERVAL = 2000
const WIP_DEBOUNCE_OPTIONS = { leading: true, trailing: true, maxWait: WIP_EVENT_INTERVAL }

const events = {
  error: 'error',
  wip: 'wip'
}

class Manager extends EventEmitter {
  constructor (db, config) {
    super()

    this.config = config
    this.db = db

    this.events = events
    this.subscriptions = new Map()

    this.nextJobCommand = plans.fetchNextJob(config.schema)
    this.insertJobCommand = plans.insertJob(config.schema)
    this.completeJobsCommand = plans.completeJobs(config.schema)
    this.cancelJobsCommand = plans.cancelJobs(config.schema)
    this.failJobsCommand = plans.failJobs(config.schema)

    // exported api to index
    this.functions = [
      this.fetch,
      this.complete,
      this.cancel,
      this.fail,
      this.publish,
      this.subscribe,
      this.unsubscribe,
      this.onComplete,
      this.offComplete,
      this.fetchCompleted,
      this.publishDebounced,
      this.publishThrottled,
      this.publishOnce,
      this.publishAfter,
      this.publishSingleton,
      this.deleteQueue,
      this.deleteAllQueues,
      this.clearStorage,
      this.getQueueSize,
      this.getJobById
    ]
  }

  async stop () {
    for (const sub of this.subscriptions.values()) {
      if (HIDDEN_QUEUES.includes(sub.name)) {
        continue
      }

      await this.unsubscribe(sub.name)
    }
  }

  async subscribe (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return this.watch(name, options, callback)
  }

  async onComplete (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return this.watch(COMPLETION_JOB_PREFIX + name, options, callback)
  }

  addWorker (worker) {
    this.subscriptions.set(worker.id, worker)
  }

  removeWorker (worker) {
    this.subscriptions.delete(worker.id)
  }

  getWorkers () {
    return Array.from(this.subscriptions.values())
  }

  getWipData () {
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
      .filter(i => i.count > 0 && !HIDDEN_QUEUES.includes(i.name))

    return data
  }

  emitWipThrottled () {
    debounce(() => this.emit(events.wip, this.getWipData()), WIP_EVENT_INTERVAL, WIP_DEBOUNCE_OPTIONS)
  }

  async watch (name, options, callback) {
    const {
      newJobCheckInterval: interval = this.config.newJobCheckInterval,
      batchSize,
      teamSize = 1,
      teamConcurrency = 1,
      includeMetadata = false
    } = options

    const id = uuid.v4()

    const fetch = () => this.fetch(name, batchSize || teamSize, { includeMetadata })

    const onFetch = async (jobs) => {
      const expirationRace = (promise, timeout) => Promise.race([
        promise,
        delay.reject(timeout, { value: new Error('job handler timeout exceeded in subscription') })
      ])

      // Failing will fail all fetched jobs
      if (batchSize) {
        const maxMs = jobs.reduce((acc, i) => Math.max(acc, plans.intervalToMs(i.expirein)))

        return await expirationRace(Promise.all([callback(jobs)]), maxMs)
          .catch(err => this.fail(jobs.map(job => job.id), err))
      }

      return await pMap(jobs, job =>
        expirationRace(callback(job), plans.intervalToMs(job.expirein))
          .then(result => this.complete(job.id, result))
          .catch(err => this.fail(job.id, err))
      , { concurrency: teamConcurrency }
      ).catch(() => {}) // allow promises & non-promises to live together in harmony
    }

    const onError = error => {
      this.emit(events.error, { ...error, queue: name, worker: id })
    }

    const worker = new Worker({ id, name, options, interval, fetch, onFetch, onError })

    this.addWorker(worker)

    worker.start()

    return id
  }

  async unsubscribe (value) {
    assert(value, 'Missing required argument')

    const query = (typeof value === 'string')
      ? { type: 'name', value, filter: i => i.name === value }
      : (typeof value === 'object' && value.worker)
          ? { type: 'worker', value: value.worker, filter: i => i.id === value.worker }
          : null

    assert(query, 'Invalid argument. Expected string or object: { worker: id }')

    const workers = this.getWorkers().filter(i => query.filter(i) && !i.stopping && !i.stopped)

    if (workers.length === 0) {
      return
    }

    for (const worker of workers) {
      worker.stop()
    }

    setInterval(() => {
      if (workers.every(w => w.stopped)) {
        for (const worker of workers) {
          this.removeWorker(worker)
        }
      }
    }, 1000)
  }

  async offComplete (name) {
    return this.unsubscribe(COMPLETION_JOB_PREFIX + name)
  }

  async publish (...args) {
    const { name, data, options } = Attorney.checkPublishArgs(args, this.config)
    return this.createJob(name, data, options)
  }

  async publishOnce (name, data, options, key) {
    options = options || {}

    options.singletonKey = key || name

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async publishSingleton (name, data, options) {
    options = options || {}

    options.singletonKey = SINGLETON_QUEUE_KEY

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async publishAfter (name, data, options, after) {
    options = options || {}
    options.startAfter = after

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async publishThrottled (name, data, options, seconds, key) {
    options = options || {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async publishDebounced (name, data, options, seconds, key) {
    options = options || {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async createJob (name, data, options, singletonOffset = 0) {
    const {
      expireIn,
      priority,
      startAfter,
      keepUntil,
      singletonKey = null,
      singletonSeconds,
      retryBackoff,
      retryLimit,
      retryDelay,
      onComplete
    } = options

    const id = uuid[this.config.uuid]()

    const values = [
      id, // 1
      name, // 2
      priority, // 3
      retryLimit, // 4
      startAfter, // 5
      expireIn, // 6
      data, // 7
      singletonKey, // 8
      singletonSeconds, // 9
      singletonOffset, // 10
      retryDelay, // 11
      retryBackoff, // 12
      keepUntil, // 13
      onComplete // 14
    ]

    const result = await this.db.executeSql(this.insertJobCommand, values)

    if (result && result.rowCount === 1) {
      return result.rows[0].id
    }

    if (!options.singletonNextSlot) {
      return null
    }

    // delay starting by the offset to honor throttling config
    options.startAfter = this.getDebounceStartAfter(singletonSeconds, this.timekeeper.clockSkew)

    // toggle off next slot config for round 2
    options.singletonNextSlot = false

    singletonOffset = singletonSeconds

    return this.createJob(name, data, options, singletonOffset)
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

  async fetch (name, batchSize, options = {}) {
    const values = Attorney.checkFetchArgs(name, batchSize, options)
    const result = await this.db.executeSql(
      this.nextJobCommand(options.includeMetadata || false),
      [values.name, batchSize || 1]
    )

    if (!result) {
      return null
    }

    const jobs = result.rows.map(job => {
      job.done = async (error, response) => {
        if (error) {
          await this.fail(job.id, error)
        } else {
          await this.complete(job.id, response)
        }
      }
      return job
    })

    return jobs.length === 0
      ? null
      : jobs.length === 1 && !batchSize
        ? jobs[0]
        : jobs
  }

  async fetchCompleted (name, batchSize, options = {}) {
    return this.fetch(COMPLETION_JOB_PREFIX + name, batchSize, options)
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

    if (data instanceof Error) { data = JSON.parse(JSON.stringify(data, Object.getOwnPropertyNames(data))) }

    return (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value: data }
  }

  mapCompletionResponse (ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      updated: result && result.rows ? parseInt(result.rows[0].count) : 0
    }
  }

  async complete (id, data) {
    const ids = this.mapCompletionIdArg(id, 'complete')
    const result = await this.db.executeSql(this.completeJobsCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async fail (id, data) {
    const ids = this.mapCompletionIdArg(id, 'fail')
    const result = await this.db.executeSql(this.failJobsCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async cancel (id) {
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const result = await this.db.executeSql(this.cancelJobsCommand, [ids])
    return this.mapCompletionResponse(ids, result)
  }

  async deleteQueue (queue, options) {
    assert(queue, 'Missing queue name argument')
    const sql = plans.deleteQueue(this.config.schema, options)
    const result = await this.db.executeSql(sql, [queue])
    return result ? result.rowCount : null
  }

  async deleteAllQueues (options) {
    const sql = plans.deleteAllQueues(this.config.schema, options)
    const result = await this.db.executeSql(sql)
    return result ? result.rowCount : null
  }

  async clearStorage () {
    const sql = plans.clearStorage(this.config.schema)
    await this.db.executeSql(sql)
  }

  async getQueueSize (queue, options) {
    assert(queue, 'Missing queue name argument')

    const sql = plans.getQueueSize(this.config.schema, options)

    const result = await this.db.executeSql(sql, [queue])

    return result ? parseFloat(result.rows[0].count) : null
  }

  async getJobById (id) {
    const fetchSql = plans.getJobById(this.config.schema)
    const result1 = await this.db.executeSql(fetchSql, [id])

    if (result1 && result1.rows && result1.rows.length === 1) {
      return result1.rows[0]
    }

    const fetchArchiveSql = plans.getArchivedJobById(this.config.schema)
    const result2 = await this.db.executeSql(fetchArchiveSql, [id])

    if (result2 && result2.rows && result2.rows.length === 1) {
      return result2.rows[0]
    }

    return null
  }
}

module.exports = Manager
