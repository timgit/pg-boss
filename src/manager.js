const assert = require('assert')
const EventEmitter = require('events')
const Promise = require('bluebird')

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
    this.deleteQueueCommand = plans.deleteQueue(config.schema)
    this.deleteAllQueuesCommand = plans.deleteAllQueues(config.schema)

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
      this.deleteAllQueues
    ]
  }

  async stop () {
    Object.keys(this.subscriptions).forEach(name => this.unsubscribe(name))
    this.subscriptions = {}
  }

  async subscribe (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args)
    return this.watch(name, options, callback)
  }

  async onComplete (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args)
    return this.watch(completedJobPrefix + name, options, callback)
  }

  async watch (name, options, callback) {
    // watch() is always nested in a promise, so assert()s are welcome

    if ('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options) {
      options = Attorney.applyNewJobCheckInterval(options)
    } else {
      options.newJobCheckInterval = this.config.newJobCheckInterval
    }

    if ('teamConcurrency' in options) {
      const teamConcurrencyErrorMessage = 'teamConcurrency must be an integer between 1 and 1000'
      assert(Number.isInteger(options.teamConcurrency) && options.teamConcurrency >= 1 && options.teamConcurrency <= 1000, teamConcurrencyErrorMessage)
    }

    if ('teamSize' in options) {
      const teamSizeErrorMessage = 'teamSize must be an integer > 0'
      assert(Number.isInteger(options.teamSize) && options.teamSize >= 1, teamSizeErrorMessage)
    }

    if ('batchSize' in options) {
      const batchSizeErrorMessage = 'batchSize must be an integer > 0'
      assert(Number.isInteger(options.batchSize) && options.batchSize >= 1, batchSizeErrorMessage)
    }

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

      const concurrency = options.teamConcurrency || 1

      // either no option was set, or teamSize was used
      return Promise.map(jobs, async job => {
        try {
          const value = await callback(job)
          await this.complete(job.id, value)
        } catch (err) {
          await this.fail(job.id, err)
        }
      }, { concurrency })
    }

    const onError = error => this.emit(events.error, error)

    const workerConfig = {
      name,
      fetch: () => this.fetch(name, options.batchSize || options.teamSize || 1),
      onFetch: jobs => sendItBruh(jobs).catch(() => {}), // just send it, bruh
      onError,
      interval: options.newJobCheckInterval
    }

    const worker = new Worker(workerConfig)
    worker.start()

    if (!this.subscriptions[name]) { this.subscriptions[name] = { workers: [] } }

    this.subscriptions[name].workers.push(worker)
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
    const { name, data, options } = Attorney.checkPublishArgs(args)
    return this.createJob(name, data, options)
  }

  async publishOnce (name, data, options, key) {
    const result = Attorney.checkPublishArgs([name, data, options])

    result.options.singletonKey = key

    return this.createJob(result.name, result.data, result.options)
  }

  async publishAfter (name, data, options, after) {
    const result = Attorney.checkPublishArgs([name, data, options])

    result.options.startAfter = after

    return this.createJob(result.name, result.data, result.options)
  }

  async publishThrottled (name, data, options, seconds, key) {
    const result = Attorney.checkPublishArgs([name, data, options])

    result.options.singletonSeconds = seconds
    result.options.singletonNextSlot = false
    result.options.singletonKey = key

    return this.createJob(result.name, result.data, result.options)
  }

  async publishDebounced (name, data, options, seconds, key) {
    const result = Attorney.checkPublishArgs([name, data, options])

    result.options.singletonSeconds = seconds
    result.options.singletonNextSlot = true
    result.options.singletonKey = key

    return this.createJob(result.name, result.data, result.options)
  }

  async createJob (name, data, options, singletonOffset) {
    let startAfter = options.startAfter

    startAfter = (startAfter instanceof Date && typeof startAfter.toISOString === 'function') ? startAfter.toISOString()
      : (startAfter > 0) ? '' + startAfter
        : (typeof startAfter === 'string') ? startAfter
          : null

    if ('retryDelay' in options) { assert(Number.isInteger(options.retryDelay) && options.retryDelay >= 0, 'retryDelay must be an integer >= 0') }

    if ('retryBackoff' in options) { assert(options.retryBackoff === true || options.retryBackoff === false, 'retryBackoff must be either true or false') }

    if ('retryLimit' in options) { assert(Number.isInteger(options.retryLimit) && options.retryLimit >= 0, 'retryLimit must be an integer >= 0') }

    let retryLimit = options.retryLimit || 0
    const retryBackoff = !!options.retryBackoff
    let retryDelay = options.retryDelay || 0

    if (retryBackoff && !retryDelay) { retryDelay = 1 }

    if (retryDelay && !retryLimit) { retryLimit = 1 }

    const expireIn = options.expireIn || '15 minutes'
    const priority = options.priority || 0

    const singletonSeconds =
      (options.singletonSeconds > 0) ? options.singletonSeconds
        : (options.singletonMinutes > 0) ? options.singletonMinutes * 60
          : (options.singletonHours > 0) ? options.singletonHours * 60 * 60
            : null

    const singletonKey = options.singletonKey || null

    singletonOffset = singletonOffset || 0

    const id = require(`uuid/${this.config.uuid}`)()

    // ordinals! [1,  2,    3,        4,          5,          6,        7,    8,            9,                10,              11,         12          ]
    const values = [id, name, priority, retryLimit, startAfter, expireIn, data, singletonKey, singletonSeconds, singletonOffset, retryDelay, retryBackoff]

    const result = await this.db.executeSql(this.insertJobCommand, values)

    if (result.rowCount === 1) {
      return result.rows[0].id
    }

    if (!options.singletonNextSlot) {
      return null
    }

    // delay starting by the offset to honor throttling config
    options.startAfter = singletonSeconds
    // toggle off next slot config for round 2
    options.singletonNextSlot = false

    singletonOffset = singletonSeconds

    return this.createJob(name, data, options, singletonOffset)
  }

  async fetch (name, batchSize) {
    const values = Attorney.checkFetchArgs(name, batchSize)
    const result = await this.db.executeSql(this.nextJobCommand, [values.name, values.batchSize || 1])

    const jobs = result.rows.map(job => {
      job.done = async (error, response) => {
        if (error) {
          console.log('job.done() got an error')
          await this.fail(job.id, error)
        } else {
          console.log('job.done() reporting success')
          await this.complete(job.id, response)
        }
      }
      return job
    })

    return jobs.length === 0 ? null
      : jobs.length === 1 && !batchSize ? jobs[0]
        : jobs
  }

  fetchCompleted (name, batchSize) {
    return this.fetch(completedJobPrefix + name, batchSize)
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

  async deleteQueue (queue) {
    assert(queue, 'Missing queue name argument')
    return this.db.executeSql(this.deleteQueueCommand, [queue])
  }

  deleteAllQueues () {
    return this.db.executeSql(this.deleteAllQueuesCommand)
  }
}

module.exports = Manager
