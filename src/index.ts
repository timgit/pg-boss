import EventEmitter from 'node:events'
import * as Attorney from './attorney.ts'
import Contractor from './contractor.ts'
import Manager from './manager.ts'
import Timekeeper, { type JobConfig as TimekeeperJobConfig } from './timekeeper.ts'
import Boss from './boss.ts'
import Bam from './bam.ts'
import { delay } from './tools.ts'
import type * as types from './types.ts'
import * as plans from './plans.ts'
import DbDefault from './db.ts'
import type { JobSpyInterface } from './spy.ts'

export { JOB_STATES as states } from './plans.ts'
export { QUEUE_POLICIES as policies } from './plans.ts'
export const events: types.Events = Object.freeze({
  error: 'error',
  warning: 'warning',
  wip: 'wip',
  stopped: 'stopped',
  bam: 'bam'
})

export function getConstructionPlans (schema?: string) {
  return Contractor.constructionPlans(schema)
}

export function getMigrationPlans (schema?: string, version?: number) {
  return Contractor.migrationPlans(schema, version)
}

export function getRollbackPlans (schema?: string, version?: number) {
  return Contractor.rollbackPlans(schema, version)
}

export class PgBoss<
  Config extends types.JobsConfig = types.DefaultJobsConfig,
  EC extends types.EventConfig<C> = Record<string, types.JobNames<Config>>,
  C extends types.JobsConfig & TimekeeperJobConfig = Config & TimekeeperJobConfig
> extends EventEmitter<types.PgBossEventMap> {
  #stoppingOn: number | null
  #stopped: boolean
  #starting: boolean | undefined
  #started: boolean | undefined
  #config: types.ResolvedConstructorOptions
  #db: (types.IDatabase & { _pgbdb?: false }) | DbDefault
  #boss: Boss<C, EC>
  #contractor: Contractor
  #manager: Manager<C, EC>
  #timekeeper: Timekeeper<C, EC>
  #bam: Bam

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

    const manager = new Manager<C, EC>(db, config)

    const boss = new Boss(db, manager, config)

    const timekeeper = new Timekeeper(db, manager, config)
    manager.timekeeper = timekeeper

    const bam = new Bam(db, config)

    this.#promoteEvents(manager)
    this.#promoteEvents(boss)
    this.#promoteEvents(timekeeper)
    this.#promoteEvents(bam)

    this.#boss = boss
    this.#contractor = contractor
    this.#manager = manager
    this.#timekeeper = timekeeper
    this.#bam = bam
  }

  #promoteEvents (emitter: types.EventsMixin) {
    for (const event of Object.values(emitter?.events) as (keyof types.PgBossEventMap)[]) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

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

    if (this.#config.migrate) {
      await this.#bam.start()
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

    let { close = true, graceful = true, timeout = 30000 } = options

    timeout = Math.max(timeout, 1000)

    this.#stoppingOn = Date.now()

    await this.#manager.stop()
    await this.#timekeeper.stop()
    await this.#boss.stop()
    await this.#bam.stop()

    const shutdown = async () => {
      await this.#manager.failWip()

      if (this.#db._pgbdb && this.#db.opened && close) {
        await this.#db.close()

        // Give event loop time to process socket closes
        await delay(10)
      }

      this.#stopped = true
      this.#stoppingOn = null
      this.#started = false

      this.emit(events.stopped)
    }

    if (!graceful) {
      return await shutdown()
    }

    while ((Date.now() - this.#stoppingOn!) < timeout && this.#manager.hasPendingCleanups()) {
      await delay(500)
    }

    await shutdown()
  }

  send<N extends types.JobNames<C>>(request: types.Request<C, N>): Promise<string | null>
  send<N extends types.JobNames<C>>(name: N, data?: types.JobInput<C, N>, options?: types.SendOptions): Promise<string | null>
  async send (...args: any[]): Promise<string | null> {
    return await this.#manager.send(...args as Parameters<Manager<C, EC>['send']>)
  }

  sendAfter<N extends types.JobNames<C>>(name: N, data: types.JobInput<C, N>, options: types.SendOptions | null, date: Date): Promise<string | null>
  sendAfter<N extends types.JobNames<C>>(name: N, data: types.JobInput<C, N>, options: types.SendOptions | null, dateString: string): Promise<string | null>
  sendAfter<N extends types.JobNames<C>>(name: N, data: types.JobInput<C, N>, options: types.SendOptions | null, seconds: number): Promise<string | null>
  async sendAfter<N extends types.JobNames<C>>(name: N, data: types.JobInput<C, N>, options: types.SendOptions | null, after: Date | string | number): Promise<string | null> {
    return this.#manager.sendAfter(name, data, options, after)
  }

  sendThrottled<N extends types.JobNames<C>>(name: N, data: types.JobInput<C, N>, options: types.SendOptions | null, seconds: number, key?: string): Promise<string | null> {
    return this.#manager.sendThrottled(name, data, options, seconds, key)
  }

  sendDebounced<N extends types.JobNames<C>>(name: N, data: types.JobInput<C, N>, options: types.SendOptions | null, seconds: number, key?: string): Promise<string | null> {
    return this.#manager.sendDebounced(name, data, options, seconds, key)
  }

  insert<N extends types.JobNames<C>>(name: N, jobs: types.JobInsert[], options?: types.InsertOptions): Promise<string[] | null> {
    return this.#manager.insert(name, jobs, options)
  }

  fetch<N extends types.JobNames<C>, T>(name: N, options: types.FetchOptions & { includeMetadata: true }): Promise<types.JobWithMetadata<T>[]>
  fetch<N extends types.JobNames<C>, T>(name: N, options?: types.FetchOptions): Promise<types.Job<T>[]>
  fetch<N extends types.JobNames<C>, T>(name: N, options: types.FetchOptions = {}): Promise<types.Job<T>[] | types.JobWithMetadata<T>[]> {
    return this.#manager.fetch<N, T>(name, options)
  }

  work<N extends types.JobNames<C>, ResData = any>(name: N, handler: types.WorkHandler<C, N, ResData>): Promise<string>
  work<N extends types.JobNames<C>, ResData = any>(name: N, options: types.WorkOptions & { includeMetadata: true }, handler: types.WorkWithMetadataHandler<C, N, ResData>): Promise<string>
  work<N extends types.JobNames<C>, ResData = any>(name: N, options: types.WorkOptions, handler: types.WorkHandler<C, N, ResData>): Promise<string>
  work (...args: any[]): Promise<string> {
    return this.#manager.work(...args as Parameters<Manager<C, EC>['work']>)
  }

  offWork<N extends types.JobNames<C>>(name: N, options?: types.OffWorkOptions): Promise<void> {
    return this.#manager.offWork(name, options)
  }

  notifyWorker (workerId: string): void {
    return this.#manager.notifyWorker(workerId)
  }

  subscribe<EventName extends types.EventNames<C, EC>>(event: EventName, name: EC[EventName]): Promise<void> {
    return this.#manager.subscribe(event, name)
  }

  unsubscribe<EventName extends types.EventNames<C, EC>>(event: EventName, name: EC[EventName]): Promise<void> {
    return this.#manager.unsubscribe(event, name)
  }

  publish<EventName extends types.EventNames<C, EC>>(event: EventName, data?: types.JobInput<C, EC[EventName]>, options?: types.SendOptions): Promise<void> {
    return this.#manager.publish(event, data, options)
  }

  cancel<N extends types.JobNames<C>>(name: N, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.cancel(name, id, options)
  }

  resume<N extends types.JobNames<C>>(name: N, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.resume(name, id, options)
  }

  retry<N extends types.JobNames<C>>(name: N, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.retry(name, id, options)
  }

  deleteJob<N extends types.JobNames<C>>(name: N, id: string | string[], options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.deleteJob(name, id, options)
  }

  deleteQueuedJobs<N extends types.JobNames<C>>(name: N): Promise<void> {
    return this.#manager.deleteQueuedJobs(name)
  }

  deleteStoredJobs<N extends types.JobNames<C>>(name: N): Promise<void> {
    return this.#manager.deleteStoredJobs(name)
  }

  deleteAllJobs<N extends types.JobNames<C>>(name?: N): Promise<void> {
    return this.#manager.deleteAllJobs(name)
  }

  complete<N extends types.JobNames<C>>(name: N, id: string | string[], data?: object | null, options?: types.CompleteOptions): Promise<types.CommandResponse> {
    return this.#manager.complete(name, id, data, options)
  }

  fail<N extends types.JobNames<C>>(name: N, id: string | string[], data?: object | null, options?: types.ConnectionOptions): Promise<types.CommandResponse> {
    return this.#manager.fail(name, id, data, options)
  }

  /**
   * @deprecated Use findJobs() instead
   */
  getJobById<N extends types.JobNames<C>, T>(name: N, id: string, options?: types.ConnectionOptions): Promise<types.JobWithMetadata<T> | null> {
    return this.#manager.getJobById<N, T>(name, id, options)
  }

  findJobs<N extends types.JobNames<C>, T = any>(name: N, options?: types.FindJobsOptions<NonNullable<types.JobInput<C, N>>>): Promise<types.JobWithMetadata<T>[]> {
    return this.#manager.findJobs<N, T>(name, options)
  }

  createQueue<N extends types.JobNames<C>>(name: N, options?: Omit<types.Queue<N>, 'name'>): Promise<void> {
    return this.#manager.createQueue(name, options)
  }

  updateQueue<N extends types.JobNames<C>>(name: N, options?: types.UpdateQueueOptions): Promise<void> {
    return this.#manager.updateQueue(name, options)
  }

  deleteQueue<N extends types.JobNames<C>>(name: N): Promise<void> {
    return this.#manager.deleteQueue(name)
  }

  getQueues<N extends types.JobNames<C>>(names?: N[]): Promise<types.QueueResult<N>[]> {
    return this.#manager.getQueues()
  }

  getQueue<N extends types.JobNames<C>>(name: N): Promise<types.QueueResult<N> | null> {
    return this.#manager.getQueue(name)
  }

  getQueueStats<N extends types.JobNames<C>>(name: N): Promise<types.QueueResult<N>> {
    return this.#manager.getQueueStats(name)
  }

  supervise (name?: string): Promise<void> {
    return this.#boss.supervise(name)
  }

  getSpy<N extends types.JobNames<C>, T = object> (name: N): JobSpyInterface<T> {
    return this.#manager.getSpy<T>(name)
  }

  clearSpies (): void {
    this.#manager.clearSpies()
  }

  isInstalled (): Promise<boolean> {
    return this.#contractor.isInstalled()
  }

  schemaVersion (): Promise<number | null> {
    return this.#contractor.schemaVersion()
  }

  schedule<N extends types.JobNames<C>>(name: N, cron: string, data?: types.JobInput<C, N>, options?: types.ScheduleOptions): Promise<void> {
    return this.#timekeeper.schedule(name, cron, data, options)
  }

  unschedule<N extends types.JobNames<C>>(name: N, key?: string): Promise<void> {
    return this.#timekeeper.unschedule(name, key)
  }

  getSchedules<N extends types.JobNames<C>>(name?: N, key?: string): Promise<types.Schedule<C, N>[]> {
    return this.#timekeeper.getSchedules(name, key)
  }

  async getBamStatus (): Promise<types.BamStatusSummary[]> {
    const sql = plans.getBamStatus(this.#config.schema)
    const { rows } = await this.#db.executeSql(sql)
    return rows
  }

  async getBamEntries (): Promise<types.BamEntry[]> {
    const sql = plans.getBamEntries(this.#config.schema)
    const { rows } = await this.#db.executeSql(sql)
    return rows
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

export type {
  BamEntry,
  BamEvent,
  BamStatusSummary,
  CompleteOptions,
  ConnectionOptions,
  ConstructorOptions,
  FetchOptions,
  FindJobsOptions,
  IDatabase as Db,
  InsertOptions,
  Job,
  JobFetchOptions,
  JobInsert,
  JobPollingOptions,
  JobStates,
  Events,
  JobWithMetadata,
  MaintenanceOptions,
  OffWorkOptions,
  Queue,
  QueueOptions,
  QueuePolicy,
  QueueResult,
  Request,
  Schedule,
  ScheduleOptions,
  SchedulingOptions,
  SendOptions,
  StopOptions,
  WipData,
  WorkHandler,
  WorkOptions,
  WorkWithMetadataHandler,
} from './types.ts'

export type {
  JobSpyInterface,
  JobSpyState,
  JobDataSelector,
  JobSelector,
  SpyJob,
} from './spy.ts'
