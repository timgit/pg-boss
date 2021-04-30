const assert = require('assert')
const EventEmitter = require('events')
const pMap = require('p-map')
const uuid = require('uuid')
const debounce = require('lodash.debounce')

const Attorney = require('./attorney')
const Worker = require('./worker')

const plans = require('./plans')
const { COMPLETION_JOB_PREFIX } = plans

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
    this.subscriptions = {}

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
      this.deleteQueue,
      this.deleteAllQueues,
      this.clearStorage,
      this.getQueueSize
    ]
  }

  async stop (options = {}) {
    const { not = null } = options

    let subs = Object.values(this.subscriptions)

    if (not) {
      subs = subs.filter(i => i.name !== not)
    }

    for (const sub of subs) {
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

  getWipData () {
    const data = Object.values(this.subscriptions)
      .map(({ name, jobs }) => ({ name, count: jobs.size() }))
      .filter(i => i.count > 0)

    return data
  }

  emitWipThrottled () {
    debounce(() => this.emit(events.wip, this.getWipData()), WIP_EVENT_INTERVAL, WIP_DEBOUNCE_OPTIONS)
  }

  registerWorker (worker) {
    const { name } = worker

    if (!this.subscriptions[name]) {
      this.subscriptions[name] = {
        name,
        workers: [],
        jobs: new Set()
      }
    }

    this.subscriptions[name].workers.push(worker)
  }

  registerJobs (name, value) {
    value = Array.isArray(value) ? value : [value]

    for (const job of value) {
      this.subscriptions[name].jobs.add(job.id)
    }

    this.emitWipThrottled()
  }

  deregisterJobs (name, value) {
    value = Array.isArray(value) ? value : [value]

    for (const jobId of value) {
      this.subscriptions[name].jobs.delete(jobId)
    }

    this.emitWipThrottled()
  }

  async watchFinish (name, value, cb) {
    try {
      await cb()
      this.deregisterJobs(name, value)
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async watchFail (name, value, data) {
    await this.watchFinish(name, value, () => this.fail(value, data))
  }

  async watchComplete (name, value, data) {
    await this.watchFinish(name, value, () => this.complete(value, data))
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
      this.registerJobs(name, jobs)

      // Failing will fail all fetched jobs
      if (batchSize) {
        return await Promise.all([callback(jobs)]).catch(err => this.watchFail(name, jobs.map(job => job.id), err))
      }

      return await pMap(jobs, job =>
        callback(job)
          .then(result => this.watchComplete(name, job.id, result))
          .catch(err => this.watchFail(name, job.id, err))
      , { concurrency: teamConcurrency }
      ).catch(() => {}) // allow promises & non-promises to live together in harmony
    }

    const onError = error => {
      console.log(error)
      this.emit(events.error, { ...error, pgbossWorker: id, pgbossQueue: name })
    }

    const worker = new Worker({ id, name, fetch, onFetch, onError, interval })

    this.registerWorker(worker)

    worker.start()
  }

  async unsubscribe (name) {
    const subscription = this.subscriptions[name]

    assert(subscription, `No subscriptions for ${name} were found.`)

    subscription.stopping = true

    subscription.workers.forEach(worker => worker.stop())

    setInterval(() => {
      if (subscription.workers.every(w => w.stopped)) {
        delete this.subscriptions[name]
      }
    }, 2000)
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

    if (result.rowCount === 1) {
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
      updated: parseInt(result.rows[0].count)
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
    return result.rowCount
  }

  async deleteAllQueues (options) {
    const sql = plans.deleteAllQueues(this.config.schema, options)
    const result = await this.db.executeSql(sql)
    return result.rowCount
  }

  async clearStorage () {
    const sql = plans.clearStorage(this.config.schema)
    await this.db.executeSql(sql)
  }

  async getQueueSize (queue, options) {
    assert(queue, 'Missing queue name argument')

    const sql = plans.getQueueSize(this.config.schema, options)

    const { rows } = await this.db.executeSql(sql, [queue])

    return parseFloat(rows[0].count)
  }
}

module.exports = Manager
