const assert = require('assert')
const EventEmitter = require('events')
const delay = require('delay')
const uuid = require('uuid')
const debounce = require('lodash.debounce')
const { serializeError: stringify } = require('serialize-error')
const pMap = require('p-map')

const Attorney = require('./attorney')
const Worker = require('./worker')
const plans = require('./plans')
const Db = require('./db')

const { QUEUES: TIMEKEEPER_QUEUES } = require('./timekeeper')
const { QUEUE_POLICY } = plans

const INTERNAL_QUEUES = Object.values(TIMEKEEPER_QUEUES).reduce((acc, i) => ({ ...acc, [i]: i }), {})

const WIP_EVENT_INTERVAL = 2000
const WIP_DEBOUNCE_OPTIONS = { leading: true, trailing: true, maxWait: WIP_EVENT_INTERVAL }

const events = {
  error: 'error',
  wip: 'wip'
}

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

class Manager extends EventEmitter {
  constructor (db, config) {
    super()

    this.config = config
    this.db = db

    this.events = events
    this.workers = new Map()

    this.nextJobCommand = plans.fetchNextJob(config.schema)
    this.insertJobCommand = plans.insertJob(config.schema)
    this.insertJobsCommand = plans.insertJobs(config.schema)
    this.completeJobsCommand = plans.completeJobs(config.schema)
    this.cancelJobsCommand = plans.cancelJobs(config.schema)
    this.resumeJobsCommand = plans.resumeJobs(config.schema)
    this.failJobsByIdCommand = plans.failJobsById(config.schema)
    this.getJobByIdCommand = plans.getJobById(config.schema)
    this.getArchivedJobByIdCommand = plans.getArchivedJobById(config.schema)
    this.subscribeCommand = plans.subscribe(config.schema)
    this.unsubscribeCommand = plans.unsubscribe(config.schema)
    this.getQueuesForEventCommand = plans.getQueuesForEvent(config.schema)

    // exported api to index
    this.functions = [
      this.complete,
      this.cancel,
      this.resume,
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
      this.getQueueProperties,
      this.deleteQueue,
      this.purgeQueue,
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

    for (const worker of this.workers.values()) {
      if (!INTERNAL_QUEUES[worker.name]) {
        await this.offWork(worker.name)
      }
    }
  }

  async failWip () {
    const jobIds = Array.from(this.workers.values()).flatMap(w => w.jobs.map(j => j.id))

    if (jobIds.length) {
      await this.fail(jobIds, 'pg-boss shut down while active')
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
      throw new Error('Workers are disabled. pg-boss is stopping.')
    }

    const {
      newJobCheckInterval: interval = this.config.newJobCheckInterval,
      batchSize,
      teamSize = 1,
      teamConcurrency = 1,
      teamRefill: refill = false,
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

    const onRefill = () => {
      queueSize--
      resolveRefillTeam()
      createTeamRefillPromise()
    }

    const fetch = () => this.fetch(name, batchSize || (teamSize - queueSize), { includeMetadata })

    const onFetch = async (jobs) => {
      if (this.config.__test__throw_worker) {
        throw new Error('__test__throw_worker')
      }

      this.emitWip(name)

      if (batchSize) {
        const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expire_in_seconds), 0)

        await resolveWithinSeconds(Promise.all([callback(jobs)]), maxExpiration)
          .then(() => this.complete(jobs.map(job => job.id)))
          .catch(err => this.fail(jobs.map(job => job.id), err))
      } else {
        if (refill) {
          queueSize += jobs.length || 1
        }

        const allTeamPromise = pMap(jobs, job =>
          resolveWithinSeconds(callback(job), job.expire_in_seconds)
            .then(result => this.complete(job.id, result))
            .catch(err => this.fail(job.id, err))
            .then(() => refill ? onRefill() : null)
        , { concurrency: teamConcurrency }
        ).catch(() => {}) // allow promises & non-promises to live together in harmony

        if (refill) {
          if (queueSize < teamSize) {
            return
          } else {
            await refillTeamPromise
          }
        } else {
          await allTeamPromise
        }
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

    const result = await this.db.executeSql(this.getQueuesForEventCommand, [event])

    if (!result || result.rowCount === 0) {
      return []
    }

    return await Promise.all(result.rows.map(({ name }) => this.send(name, ...args)))
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
      db: wrapper,
      expireIn,
      priority,
      startAfter,
      keepUntil,
      singletonKey = null,
      singletonSeconds,
      retryBackoff,
      retryLimit,
      retryDelay,
      deadLetter = null
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
      deadLetter // 14
    ]
    const db = wrapper || this.db
    const result = await db.executeSql(this.insertJobCommand, values)

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

  async insert (jobs, options = {}) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const db = options.db || this.db

    return await db.executeSql(this.insertJobsCommand, [JSON.stringify(jobs)])
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
    const patternMatch = Attorney.queueNameHasPatternMatch(name)
    const values = Attorney.checkFetchArgs(name, batchSize, options)
    const db = options.db || this.db
    const nextJobSql = this.nextJobCommand(options.includeMetadata || false, patternMatch)
    const statementValues = [values.name, batchSize || 1]

    let result

    try {
      if (!options.db) {
        // Prepare/format now and send multi-statement transaction
        const fetchQuery = nextJobSql
          .replace('$1', Db.quotePostgresStr(statementValues[0]))
          .replace('$2', statementValues[1].toString())

        // eslint-disable-next-line no-unused-vars
        const [_begin, _setLocal, fetchResult, _commit] = await db.executeSql([
          'BEGIN',
          'SET LOCAL jit = OFF', // JIT can slow things down significantly
          fetchQuery,
          'COMMIT'
        ].join(';\n'))
        result = fetchResult
      } else {
        result = await db.executeSql(nextJobSql, statementValues)
      }
    } catch (err) {
      // errors from fetchquery should only be unique constraint violations
    }

    if (!result || result.rows.length === 0) {
      return null
    }

    return result.rows.length === 1 && !batchSize ? result.rows[0] : result.rows
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

  mapCompletionResponse (ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      updated: result && result.rows ? parseInt(result.rows[0].count) : 0
    }
  }

  async complete (id, data, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'complete')
    const result = await db.executeSql(this.completeJobsCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async fail (id, data, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'fail')
    const result = await db.executeSql(this.failJobsByIdCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async cancel (id, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const result = await db.executeSql(this.cancelJobsCommand, [ids])
    return this.mapCompletionResponse(ids, result)
  }

  async resume (id, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'resume')
    const result = await db.executeSql(this.resumeJobsCommand, [ids])
    return this.mapCompletionResponse(ids, result)
  }

  async createQueue (name, options = {}) {
    assert(name, 'Missing queue name argument')

    const { policy = QUEUE_POLICY.standard } = options

    assert(policy in QUEUE_POLICY, `${policy} is not a valid queue policy`)

    const {
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    } = Attorney.checkQueueArgs(name, options)

    const paritionSql = plans.createQueueTablePartition(this.config.schema, name)

    await this.db.executeSql(paritionSql)

    const sql = plans.createQueue(this.config.schema, name)

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

    await this.db.executeSql(sql, params)
  }

  async updateQueue (name, options = {}) {
    assert(name, 'Missing queue name argument')

    const {
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    } = Attorney.checkQueueArgs(name, options)

    const sql = plans.updateQueue(this.config.schema)

    const params = [
      name,
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    ]

    await this.db.executeSql(sql, params)
  }

  async getQueueProperties (name) {
    assert(name, 'Missing queue name argument')

    const sql = plans.getQueueByName(this.config.schema)
    const result = await this.db.executeSql(sql, [name])

    return result.rows.length ? result.rows[0] : null
  }

  async deleteQueue (name) {
    assert(name, 'Missing queue name argument')

    const queueSql = plans.getQueueByName(this.config.schema)
    const result = await this.db.executeSql(queueSql, [name])

    if (result?.rows?.length) {
      Attorney.assertPostgresObjectName(name)
      const sql = plans.dropQueueTablePartition(this.config.schema, name)
      await this.db.executeSql(sql)
    }

    const sql = plans.deleteQueueRecords(this.config.schema)
    const result2 = await this.db.executeSql(sql, [name])
    return result2?.rowCount || null
  }

  async purgeQueue (queue) {
    assert(queue, 'Missing queue name argument')
    const sql = plans.purgeQueue(this.config.schema)
    await this.db.executeSql(sql, [queue])
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

  async getJobById (id, options = {}) {
    const db = options.db || this.db
    const result1 = await db.executeSql(this.getJobByIdCommand, [id])

    if (result1 && result1.rows && result1.rows.length === 1) {
      return result1.rows[0]
    }

    const result2 = await db.executeSql(this.getArchivedJobByIdCommand, [id])

    if (result2 && result2.rows && result2.rows.length === 1) {
      return result2.rows[0]
    }

    return null
  }
}

module.exports = Manager
