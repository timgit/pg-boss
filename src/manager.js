const assert = require('assert')
const EventEmitter = require('events')
const pMap = require('p-map')
const delay = require('delay')
const uuid = require('uuid')
const debounce = require('lodash.debounce')

const Attorney = require('./attorney')
const Worker = require('./worker')

const { QUEUES: BOSS_QUEUES } = require('./boss')
const { QUEUES: TIMEKEEPER_QUEUES } = require('./timekeeper')

const INTERNAL_QUEUES = Object.values(BOSS_QUEUES).concat(Object.values(TIMEKEEPER_QUEUES)).reduce((acc, i) => ({ ...acc, [i]: i }), {})

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
    this.insertJobsCommand = plans.insertJobs(config.schema)
    this.completeJobsCommand = plans.completeJobs(config.schema)
    this.cancelJobsCommand = plans.cancelJobs(config.schema)
    this.failJobsCommand = plans.failJobs(config.schema)
    this.getJobByIdCommand = plans.getJobById(config.schema)
    this.getArchivedJobByIdCommand = plans.getArchivedJobById(config.schema)

    // exported api to index
    this.functions = [
      this.fetch,
      this.complete,
      this.cancel,
      this.fail,
      this.publish,
      this.insert,
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

    this.emitWipThrottled = debounce(() => this.emit(events.wip, this.getWipData()), WIP_EVENT_INTERVAL, WIP_DEBOUNCE_OPTIONS)
  }

  start () {
    this.stopping = false
  }

  async stop () {
    this.stopping = true

    for (const sub of this.subscriptions.values()) {
      if (!INTERNAL_QUEUES[sub.name]) {
        await this.unsubscribe(sub.name)
      }
    }
  }

  async subscribe (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return await this.watch(name, options, callback)
  }

  async onComplete (name, ...args) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return await this.watch(COMPLETION_JOB_PREFIX + name, options, callback)
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

  emitWip (name) {
    if (!INTERNAL_QUEUES[name]) {
      this.emitWipThrottled()
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
    if (this.stopping) {
      throw new Error('Subscriptions are disabled. pg-boss is stopping.')
    }

    const {
      newJobCheckInterval: interval = this.config.newJobCheckInterval,
      batchSize,
      teamSize = 1,
      teamConcurrency = 1,
      includeMetadata = false
    } = options

    const id = uuid.v4()

    let queueSize = 0

    let refillTeamPromise
    let resolveRefillTeam
    // Setup a promise that onFetch can await for when at least one
    // job is finished and so the team is ready to be topped up
    const createTeamRefillPromise = () => {
      refillTeamPromise = new Promise((resolve) => { resolveRefillTeam = resolve })
    }
    createTeamRefillPromise()

    const jobFinally = () => {
      queueSize--
      // Resolves the promise returned by onFetch
      // allowing the worker to fetch a new batch of jobs
      resolveRefillTeam()
      // We'll need a new promise for the next onFetch to wait for
      createTeamRefillPromise()
    }

    const fetch = () => this.fetch(name, batchSize || (teamSize - queueSize), { includeMetadata })

    const onFetch = async (jobs) => {
      if (this.config.__test__throw_subscription) {
        throw new Error('__test__throw_subscription')
      }

      queueSize += jobs.length || 1

      const resolveWithinSeconds = async (promise, seconds) => {
        const timeout = Math.max(1, seconds) * 1000
        const reject = delay.reject(timeout, { value: new Error(`handler execution exceeded ${timeout}ms`) })

        let result

        try {
          result = await Promise.race([promise, reject])
        } finally {
          try {
            reject.clear()
          } catch {}
        }

        return result
      }

      this.emitWip(name)

      let result

      if (batchSize) {
        const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expire_in_seconds), 0)

        // Failing will fail all fetched jobs
        result = await resolveWithinSeconds(Promise.all([callback(jobs)]), maxExpiration)
          .catch(err => this.fail(jobs.map(job => job.id), err))
      } else {
        pMap(jobs, job =>
          resolveWithinSeconds(callback(job), job.expire_in_seconds)
            .then(result => this.complete(job.id, result))
            .catch(err => this.fail(job.id, err))
            // Trigger a queue top-up whenever a job finishes or times out
            .then(() => jobFinally())
        , { concurrency: teamConcurrency }
        ).catch(() => {}) // allow promises & non-promises to live together in harmony
      }

      this.emitWip(name)

      if (batchSize) return result

      // It's possible that another job finished while
      // this batch was being fetched, in which case
      // there may be 1 or more additional slots to fill
      // in the next interval
      // So check the queueSize and return immediately if it's
      // not full
      // otherwise, wait for a job to complete which will
      // resolve refillTeamPromise
      return (queueSize < teamSize) ? null : refillTeamPromise
    }

    const onError = error => {
      this.emit(events.error, { ...error, message: error.message, stack: error.stack, queue: name, worker: id })
    }

    const worker = new Worker({ id, name, options, interval, fetch, onFetch, onError })

    this.addWorker(worker)

    worker.start()

    return id
  }

  async unsubscribe (value) {
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

  async offComplete (value) {
    if (typeof value === 'string') {
      value = COMPLETION_JOB_PREFIX + value
    }

    return await this.unsubscribe(value)
  }

  async publish (...args) {
    const { name, data, options } = Attorney.checkPublishArgs(args, this.config)
    return await this.createJob(name, data, options)
  }

  async publishOnce (name, data, options, key) {
    options = options || {}

    options.singletonKey = key || name

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async publishSingleton (name, data, options) {
    options = options || {}

    options.singletonKey = SINGLETON_QUEUE_KEY

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async publishAfter (name, data, options, after) {
    options = options || {}
    options.startAfter = after

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async publishThrottled (name, data, options, seconds, key) {
    options = options || {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async publishDebounced (name, data, options, seconds, key) {
    options = options || {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
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

    return await this.createJob(name, data, options, singletonOffset)
  }

  async insert (jobs) {
    assert(Array.isArray(jobs), `jobs argument should be an array.  Received '${typeof jobs}'`)
    const data = JSON.stringify(jobs)
    return await this.db.executeSql(this.insertJobsCommand, [data])
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

    if (!result || result.rows.length === 0) {
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

    return jobs.length === 1 && !batchSize ? jobs[0] : jobs
  }

  async fetchCompleted (name, batchSize, options = {}) {
    return await this.fetch(COMPLETION_JOB_PREFIX + name, batchSize, options)
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

    if (data instanceof Error) {
      const newData = {}
      Object.getOwnPropertyNames(data).forEach(key => { newData[key] = data[key] })
      data = newData
    }

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
    const result1 = await this.db.executeSql(this.getJobByIdCommand, [id])

    if (result1 && result1.rows && result1.rows.length === 1) {
      return result1.rows[0]
    }

    const result2 = await this.db.executeSql(this.getArchivedJobByIdCommand, [id])

    if (result2 && result2.rows && result2.rows.length === 1) {
      return result2.rows[0]
    }

    return null
  }
}

module.exports = Manager
