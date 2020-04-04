import assert from 'assert'
import { EventEmitter } from 'events'
import bluebird from 'bluebird'
import * as uuid from 'uuid'
import { QueryResult } from 'pg'
import Worker from './worker'
import Db from './db'
import * as plans from './plans'
import * as Attorney from './attorney'
import { PublishOptions, PublishArgs, SubscribeOptions, SubscribeCallback, CheckSubscribeArgs } from './attorney'
import { BossConfig, WorkerConfig, JobWithDoneCallback, Job } from './config'

const completedJobPrefix = plans.completedJobPrefix

const events = Object.freeze({
  error: 'error'
})

type UUID = ReturnType<typeof uuid.v1>

interface CompletionResponse {
  /**
   * Job IDs (`UUID[]`)
  */
  jobs: UUID[]
  requested: number
  updated: number
}

declare interface Manager {
  on(event: typeof events.error, handler: (error: Error) => void): this
}

class Manager extends EventEmitter {
  private readonly events: typeof events
  private subscriptions: Record<string, { workers: Worker[] }>

  // exported api to index
  public readonly functions = [
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

  private readonly nextJobCommand: string
  private readonly insertJobCommand: string
  private readonly completeJobsCommand: string
  private readonly cancelJobsCommand: string
  private readonly failJobsCommand: string
  private readonly deleteQueueCommand: string
  private readonly deleteAllQueuesCommand: string

  constructor (private readonly db: Db, private readonly config: BossConfig) {
    super()

    this.events = events
    this.subscriptions = {}

    this.nextJobCommand = plans.fetchNextJob(config.schema)
    this.insertJobCommand = plans.insertJob(config.schema)
    this.completeJobsCommand = plans.completeJobs(config.schema)
    this.cancelJobsCommand = plans.cancelJobs(config.schema)
    this.failJobsCommand = plans.failJobs(config.schema)
    this.deleteQueueCommand = plans.deleteQueue(config.schema)
    this.deleteAllQueuesCommand = plans.deleteAllQueues(config.schema)
  }

  async stop () {
    await Promise.all(Object.keys(this.subscriptions).map(name => this.unsubscribe(name)))
    this.subscriptions = {}
  }

  async subscribe (name: string, ...args: CheckSubscribeArgs) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return this.watch(name, options, callback)
  }

  async onComplete (name: string, ...args: CheckSubscribeArgs) {
    const { options, callback } = Attorney.checkSubscribeArgs(name, args, this.config)
    return this.watch(completedJobPrefix + name, options, callback)
  }

  async watch (name: string, options: SubscribeOptions, callback: SubscribeCallback) {
    options.newJobCheckInterval = options.newJobCheckInterval || this.config.newJobCheckInterval

    const sendItBruh = async (jobs: JobWithDoneCallback[]) => {
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
      return bluebird.map(jobs, job =>
        callback(job)
          .then((value: object) => this.complete(job.id, value))
          .catch((err: Error) => this.fail(job.id, err))
      , { concurrency }
      ).catch(() => {}) // allow promises & non-promises to live together in harmony
    }

    const onError = (error: Error) => this.emit(events.error, error)

    const workerConfig: WorkerConfig = {
      name,
      fetch: () => this.fetch(name, options.batchSize || options.teamSize || 1),
      onFetch: (jobs: JobWithDoneCallback[]) => sendItBruh(jobs),
      onError,
      interval: options.newJobCheckInterval
    }

    const worker = new Worker(workerConfig)
    worker.start()

    if (!this.subscriptions[name]) { this.subscriptions[name] = { workers: [] } }

    this.subscriptions[name].workers.push(worker)
  }

  async unsubscribe (name: string) {
    assert(this.subscriptions[name], `No subscriptions for ${name} were found.`)

    this.subscriptions[name].workers.forEach(worker => worker.stop())
    delete this.subscriptions[name]
  }

  async offComplete (name: string) {
    return this.unsubscribe(completedJobPrefix + name)
  }

  async publish (...args: PublishArgs) {
    const { name, data, options } = Attorney.checkPublishArgs(args, this.config)
    return this.createJob(name, data, options)
  }

  async publishOnce (name: string, data: object, options: PublishOptions, key: string) {
    options = options || {}
    options.singletonKey = key

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async publishAfter (name: string, data: object, options: PublishOptions, after: PublishOptions['startAfter']) {
    options = options || {}
    options.startAfter = after

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async publishThrottled (name: string, data: object, options: PublishOptions, seconds: number, key?: string) {
    options = options || {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async publishDebounced (name: string, data: object, options: PublishOptions, seconds: number, key?: string) {
    options = options || {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    return this.createJob(result.name, result.data, result.options)
  }

  async createJob (name: string, data: object, options: PublishOptions, singletonOffset = 0) {
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
    options.startAfter = singletonSeconds
    // toggle off next slot config for round 2
    options.singletonNextSlot = false

    singletonOffset = singletonSeconds

    return this.createJob(name, data, options, singletonOffset)
  }

  async fetch (name: string, batchSize: number) {
    const values = Attorney.checkFetchArgs(name, batchSize)
    const result = await this.db.executeSql<Job>(this.nextJobCommand, [values.name, batchSize || 1])

    const jobs = result.rows.map<JobWithDoneCallback>(job => {
      return {
        ...job,

        done: async (error: Error, response: object) => {
          if (error) {
            await this.fail(job.id, error)
          } else {
            await this.complete(job.id, response)
          }
        }
      }
    })

    return jobs.length === 0 ? null
      : jobs.length === 1 && !batchSize ? jobs[0]
        : jobs
  }

  async fetchCompleted (name: string, batchSize: number) {
    return this.fetch(completedJobPrefix + name, batchSize)
  }

  mapCompletionIdArg (id: UUID | UUID[], funcName: string): UUID[] {
    const errorMessage = `${funcName}() requires an id`

    assert(id, errorMessage)

    const ids = Array.isArray(id) ? id : [id]

    assert(ids.length, errorMessage)

    return ids
  }

  mapCompletionDataArg (data: object | Error): object | object[] | null {
    if (data === null || typeof data === 'undefined' || typeof data === 'function') { return null }

    if (data instanceof Error) { data = JSON.parse(JSON.stringify(data, Object.getOwnPropertyNames(data))) }

    return (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value: data }
  }

  mapCompletionResponse (ids: UUID[], result: QueryResult<any>): CompletionResponse {
    return {
      jobs: ids,
      requested: ids.length,
      updated: result.rowCount
    }
  }

  async complete (id: UUID[]): Promise<CompletionResponse>
  async complete (id: UUID): Promise<CompletionResponse>
  async complete (id: UUID, data: object): Promise<CompletionResponse>
  async complete (id: UUID | UUID[], data?: object): Promise<CompletionResponse> {
    const ids = this.mapCompletionIdArg(id, 'complete')
    const result = await this.db.executeSql(this.completeJobsCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async fail (id: UUID[]): Promise<CompletionResponse>
  async fail (id: UUID[], data: object): Promise<CompletionResponse>
  async fail (id: UUID): Promise<CompletionResponse>
  async fail (id: UUID, data: object): Promise<CompletionResponse>
  async fail (id: UUID | UUID[], data?: object): Promise<CompletionResponse> {
    const ids = this.mapCompletionIdArg(id, 'fail')
    const result = await this.db.executeSql(this.failJobsCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async cancel (id: UUID): Promise<CompletionResponse>
  async cancel (id: UUID[]): Promise<CompletionResponse>
  async cancel (id: UUID | UUID[]): Promise<CompletionResponse> {
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const result = await this.db.executeSql(this.cancelJobsCommand, [ids])
    return this.mapCompletionResponse(ids, result)
  }

  async deleteQueue (queue: string) {
    assert(queue, 'Missing queue name argument')
    return this.db.executeSql(this.deleteQueueCommand, [queue])
  }

  async deleteAllQueues () {
    return this.db.executeSql(this.deleteAllQueuesCommand)
  }
}

export = Manager
