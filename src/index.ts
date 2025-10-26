import EventEmitter from 'node:events'
import * as plans from './plans.js'
import * as Attorney from './attorney.js'
import Contractor from './contractor.js'
import Manager from './manager.js'
import Timekeeper from './timekeeper.js'
import Boss from './boss.js'
import { delay } from './tools.js'
import type * as types from './types.js'
import DbDefault from './db.js'

const events = {
  error: 'error',
  stopped: 'stopped'
} as const

class PgBoss extends EventEmitter<types.PgBossEventMap> {
  #stoppingOn: number | null
  #stopped: boolean
  #starting: boolean | undefined
  #started: boolean | undefined
  #config: types.ResolvedConstructorOptions
  #db: (types.IDatabase & { _pgbdb?: false }) | DbDefault
  #boss: Boss
  #contractor: Contractor
  #manager: Manager
  #timekeeper: Timekeeper

  constructor (connectionString: string)
  constructor (options: types.ConstructorOptions)
  constructor (value: string | types.ConstructorOptions) {
    super()
    this.#stoppingOn = null
    this.#stopped = true

    const config = Attorney.getConfig(value)
    this.#config = config

    const db: (types.IDatabase & { _pgbdb?: false }) | DbDefault = this.getDb()
    this.#db = db

    if ('_pgbdb' in this.#db && this.#db._pgbdb) {
      this.#promoteEvents(this.#db)
    }

    const contractor = new Contractor(db, config)

    const manager = new Manager(db, config)

    const boss = new Boss(db, manager, config)

    const timekeeper = new Timekeeper(db, manager, config)
    manager.timekeeper = timekeeper

    this.#promoteEvents(manager)
    this.#promoteEvents(boss)
    this.#promoteEvents(timekeeper)

    this.#boss = boss
    this.#contractor = contractor
    this.#manager = manager
    this.#timekeeper = timekeeper
  }

  #promoteEvents (emitter: types.EventsMixin) {
    for (const event of Object.values(emitter?.events) as (keyof types.PgBossEventMap)[]) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  // Public API

  static getConstructionPlans (schema?: string) {
    return Contractor.constructionPlans(schema)
  }

  static getMigrationPlans (schema?: string, version?: number) {
    return Contractor.migrationPlans(schema, version)
  }

  static getRollbackPlans (schema?: string, version?: number) {
    return Contractor.rollbackPlans(schema, version)
  }

  static states: types.JobStates = plans.JOB_STATES
  static policies: types.QueuePolicies = plans.QUEUE_POLICIES

  async start (): Promise<this> {
    if (this.#starting || this.#started) {
      return this
    }

    this.#starting = true

    if (this.#db._pgbdb && !this.#db.opened) {
      await this.#db.open()
    }

    if (this.#config.migrate) {
      await this.#contractor.start()
    } else {
      await this.#contractor.check()
    }

    await this.#manager.start()

    if (this.#config.supervise) {
      await this.#boss.start()
    }

    if (this.#config.schedule) {
      await this.#timekeeper.start()
    }

    this.#starting = false
    this.#started = true
    this.#stopped = false

    return this
  }

  async stop (options: types.StopOptions = {}): Promise<void> {
    if (this.#stoppingOn || this.#stopped) {
      return
    }

    let { close = true, graceful = true, timeout = 30000, wait = true } = options

    timeout = Math.max(timeout, 1000)

    this.#stoppingOn = Date.now()

    await this.#manager.stop()
    await this.#timekeeper.stop()
    await this.#boss.stop()

    await new Promise<void>((resolve, reject) => {
      const shutdown = async () => {
        try {
          if (this.#config.__test__throw_shutdown) {
            throw new Error(this.#config.__test__throw_shutdown)
          }

          await this.#manager.failWip()

          if (this.#db._pgbdb && this.#db.opened && close) {
            await this.#db.close()
          }

          this.#stopped = true
          this.#stoppingOn = null
          this.#started = false

          this.emit(events.stopped)
          resolve()
        } catch (err: any) {
          this.emit(events.error, err)
          reject(err)
        }
      }

      if (!graceful) {
        return shutdown()
      }

      if (!wait) {
        resolve()
      }

      setImmediate(async () => {
        try {
          if (this.#config.__test__throw_stop_monitor) {
            throw new Error(this.#config.__test__throw_stop_monitor)
          }

          const isWip = () => this.#manager.getWipData({ includeInternal: false }).length > 0

          while ((Date.now() - this.#stoppingOn!) < timeout && isWip()) {
            await delay(500)
          }

          await shutdown()
        } catch (err: any) {
          reject(err)
          this.emit(events.error, err)
        }
      })
    })
  }

  send (request: types.Request): Promise<string | null>
  send (name: string, data?: object, options?: types.SendOptions): Promise<string | null>
  async send (...args: any[]): Promise<string | null> {
    return await this.#manager.send(...args as Parameters<Manager['send']>)
  }

  sendAfter (name: string, data: object, options: types.SendOptions, date: Date): Promise<string | null>
  sendAfter (name: string, data: object, options: types.SendOptions, dateString: string): Promise<string | null>
  sendAfter (name: string, data: object, options: types.SendOptions, seconds: number): Promise<string | null>
  async sendAfter (name: string, data: object, options: types.SendOptions, after: Date | string | number): Promise<string | null> {
    return this.#manager.sendAfter(name, data, options, after)
  }

  sendThrottled (name: string, data: object, options: types.SendOptions, seconds: number, key?: string): Promise<string | null> {
    return this.#manager.sendThrottled(name, data, options, seconds, key)
  }

  sendDebounced (name: string, data: object, options: types.SendOptions, seconds: number, key?: string): Promise<string | null> {
    return this.#manager.sendDebounced(name, data, options, seconds, key)
  }

  insert (name: string, jobs: types.JobInsert[], options?: types.InsertOptions): Promise<string[] | null> {
    return this.#manager.insert(name, jobs, options)
  }

  fetch<T>(name: string, options: types.FetchOptions & { includeMetadata: true }): Promise<types.JobWithMetadata<T>[]>
  fetch<T>(name: string, options?: types.FetchOptions): Promise<types.Job<T>[]>
  fetch<T>(name: string, options: types.FetchOptions = {}): Promise<types.Job<T>[] | types.JobWithMetadata<T>[]> {
    return this.#manager.fetch<T>(name, options)
  }

  work<ReqData>(name: string, handler: types.WorkHandler<ReqData>): Promise<string>
  work<ReqData>(name: string, options: types.WorkOptions & { includeMetadata: true }, handler: types.WorkWithMetadataHandler<ReqData>): Promise<string>
  work<ReqData>(name: string, options: types.WorkOptions, handler: types.WorkHandler<ReqData>): Promise<string>
  work (...args: any[]): Promise<string> {
    return this.#manager.work(...args as Parameters<Manager['work']>)
  }

  offWork (name: string): Promise<void>
  offWork (options: types.OffWorkOptions): Promise<void>
  offWork (value: string | types.OffWorkOptions): Promise<void> {
    return this.#manager.offWork(value)
  }

  notifyWorker (workerId: string): void {
    this.#manager.notifyWorker(workerId)
  }

  subscribe (event: string, name: string): Promise<void> {
    return this.#manager.subscribe(event, name)
  }

  unsubscribe (event: string, name: string): Promise<void> {
    return this.#manager.unsubscribe(event, name)
  }

  publish (event: string, data?: object, options?: types.SendOptions): Promise<void> {
    return this.#manager.publish(event, data, options)
  }

  cancel (name: string, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.cancel(name, id, options)
  }

  resume (name: string, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.resume(name, id, options)
  }

  retry (name: string, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.retry(name, id, options)
  }

  deleteJob (name: string, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.deleteJob(name, id, options)
  }

  deleteQueuedJobs (name: string): Promise<void> {
    return this.#manager.deleteQueuedJobs(name)
  }

  deleteStoredJobs (name: string): Promise<void> {
    return this.#manager.deleteStoredJobs(name)
  }

  deleteAllJobs (name: string): Promise<void> {
    return this.#manager.deleteAllJobs(name)
  }

  complete (name: string, id: string | string[], data?: object, options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.complete(name, id, data, options)
  }

  fail (name: string, id: string | string[], data?: object, options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.fail(name, id, data, options)
  }

  getJobById<T>(name: string, id: string, options?: types.ConnectionOptions): Promise<types.JobWithMetadata<T> | null> {
    return this.#manager.getJobById<T>(name, id, options)
  }

  createQueue (name: string, options?: Omit<types.Queue, 'name'>): Promise<void> {
    return this.#manager.createQueue(name, options)
  }

  updateQueue (name: string, options?: types.UpdateQueueOptions): Promise<void> {
    return this.#manager.updateQueue(name, options)
  }

  deleteQueue (name: string): Promise<void> {
    return this.#manager.deleteQueue(name)
  }

  getQueues (names?: string[]): Promise<types.QueueResult[]> {
    return this.#manager.getQueues()
  }

  getQueue (name: string): Promise<types.QueueResult | null> {
    return this.#manager.getQueue(name)
  }

  getQueueStats (name: string): Promise<types.QueueResult> {
    return this.#manager.getQueueStats(name)
  }

  supervise (name?: string): Promise<void> {
    return this.#boss.supervise(name)
  }

  isInstalled (): Promise<boolean> {
    return this.#contractor.isInstalled()
  }

  schemaVersion (): Promise<number | null> {
    return this.#contractor.schemaVersion()
  }

  schedule (name: string, cron: string, data?: object, options?: types.ScheduleOptions): Promise<void> {
    return this.#timekeeper.schedule(name, cron, data, options)
  }

  unschedule (name: string, key?: string): Promise<void> {
    return this.#timekeeper.unschedule(name, key)
  }

  getSchedules (name?: string, key?: string): Promise<types.Schedule[]> {
    return this.#timekeeper.getSchedules(name, key)
  }

  getDb (): types.IDatabase {
    if (this.#db) {
      return this.#db
    }

    if (this.#config.db) {
      return this.#config.db
    }

    return new DbDefault(this.#config)
  }
}

export const {
  states,
  policies,
  getConstructionPlans,
  getMigrationPlans,
  getRollbackPlans,
} = PgBoss

export default PgBoss

export { PgBoss }

export type {
  ConnectionOptions,
  ConstructorOptions,
  FetchOptions,
  IDatabase as Db,
  Job,
  JobFetchOptions,
  JobInsert,
  JobPollingOptions,
  JobStates,
  JobWithMetadata,
  MaintenanceOptions,
  OffWorkOptions,
  Queue,
  QueuePolicies,
  QueueResult,
  Request,
  Schedule,
  ScheduleOptions,
  SchedulingOptions,
  StopOptions,
  WipData,
  WorkHandler,
  WorkOptions,
  WorkWithMetadataHandler,
} from './types.js'
