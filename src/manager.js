const assert = require('assert')
const EventEmitter = require('events')
const Promise = require('bluebird')
const uuid = require('uuid')
const { default: PQueue } = require('p-queue')

const Worker = require('./worker')
const plans = require('./plans')
const Attorney = require('./attorney')

const completedJobPrefix = plans.completedJobPrefix

const events = {
  error: 'error'
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

  async stop () {
    Object.keys(this.subscriptions).forEach(name => this.unsubscribe(name))
    this.subscriptions = {}
  }

  async subscribe (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return this.watch(name, options, callback)
  }

  async onComplete (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return this.watch(completedJobPrefix + name, options, callback)
  }

  async watch (name, options, callback) {
    options.newJobCheckInterval = options.newJobCheckInterval || this.config.newJobCheckInterval

    const teamQueue = options.batchSize ? null : new PQueue({ concurrency: options.teamConcurrency || 1 })
    const teamSize = options.teamSize || 1
    const queueSize = () => teamQueue.size + teamQueue.pending

    const sendItBruh = async (jobs) => {
      if (!jobs) {
        return
      }

      // If you get a batch, for now you should use complete() so you can control
      //   whether individual or group completion responses apply to your use case
      // Failing will fail all fetched jobs
      if (options.batchSize) {
        return Promise.all([callback(jobs)]).catch(err => this.fail(jobs.map(job => job.id), err))
      }

      let resolveWorker
      const continueWorker = new Promise(resolve => { resolveWorker = resolve })

      // Resume the worker loop only when there's a minimum number of jobs ready
      // or on first job if no minimum is specified
      // (or if there's nothing in the queue so we don't jam on bad input)
      const nextJobHandler = () => {
        const pending = queueSize()
        if (!options.teamMinimumFetch ||
          !pending ||
          (teamSize - pending) > options.teamMinimumFetch) {
          resolveWorker()
          teamQueue.off('next', nextJobHandler)
        }
      }

      teamQueue.on('next', nextJobHandler)

      jobs.forEach(job =>
        teamQueue.add(async () => {
          try {
            const result = callback(job)

            // If the caller returns a promise
            if (typeof (result || {}).then === 'function') {
              const timeout = this.expiringJobPromise(job);
              return Promise.race([result, timeout])
                .then((value) => this.complete(job.id, value))
                .catch((err) => this.fail(job.id, err))
                .catch(() => {})
            }
          } catch (e) {}
        })
      )

      return continueWorker
    }

    const fetchOptions = { includeMetadata: options.includeMetadata || false }
    const onError = error => this.emit(events.error, error)

    const workerConfig = {
      name,
      fetch: () => this.fetch(name, options.batchSize || teamSize - queueSize(), fetchOptions),
      onFetch: jobs => sendItBruh(jobs),
      onError,
      interval: options.newJobCheckInterval
    }

    const worker = new Worker(workerConfig)
    worker.start()

    if (!this.subscriptions[name]) { this.subscriptions[name] = { workers: [] } }

    this.subscriptions[name].workers.push(worker)
  }

  async expiringJobPromise(job) {
    var times = {
      // I really hope no-one is keeping a promise
      // hanging for days
      days: 86400000,
      hours: 3600000,
      minutes: 60000,
      seconds: 1000,
      milliseconds: 1,
    };
    const time = Object.keys(job.expirein).reduce((total, key) => total += times[key] * job.expirein[key], 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Job expired'));
      }, time);
    })
  }

  async unsubscribe (name) {
    assert(this.subscriptions[name], `No subscriptions for ${name} were found.`)

    this.subscriptions[name].workers.forEach(worker => worker.stop())
    delete this.subscriptions[name]
  }

  async offComplete (name) {
    return this.unsubscribe(completedJobPrefix + name)
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
      retryDelay
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
      keepUntil // 13
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

    return jobs.length === 0 ? null
      : jobs.length === 1 && !batchSize ? jobs[0]
        : jobs
  }

  async fetchCompleted (name, batchSize, options = {}) {
    return this.fetch(completedJobPrefix + name, batchSize, options)
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
      updated: result.rowCount
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
