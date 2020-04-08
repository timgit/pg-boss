import { EventEmitter } from 'events'
import * as plans from './plans'
import { BossConfig, DatabaseInterface } from './config'
import Manager from './manager'

const queues = Object.freeze({
  MAINTENANCE: '__pgboss__maintenance',
  MONITOR_STATES: '__pgboss__monitor-states'
} as const)

const events = Object.freeze({
  error: 'error',
  archived: 'archived',
  deleted: 'deleted',
  expired: 'expired',
  monitorStates: 'monitor-states',
  maintenance: 'maintenance'
} as const)

interface MaintenanceEvent {
  count: number
  ms: number
}

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T
type MonitorStatesEvent = ThenArg<ReturnType<Boss['countStates']>>

declare interface Boss {
  on(event: typeof events.archived, handler: (count: number) => void): this
  on(event: typeof events.expired, handler: (count: number) => void): this
  on(event: typeof events.deleted, handler: (count: number) => void): this
  on(event: typeof events.error, handler: (error: Error) => void): this
  on(event: typeof events.maintenance, handler: (maintenance: MaintenanceEvent) => void): this
  on(event: typeof events.monitorStates, handler: (monitorStates: MonitorStatesEvent) => void): this
}

class Boss extends EventEmitter {
  private readonly maintenanceIntervalSeconds: BossConfig['maintenanceIntervalSeconds']
  private readonly monitorStates: boolean
  private readonly monitorIntervalSeconds: BossConfig['monitorStateIntervalSeconds']
  public readonly events = events
  private readonly expireCommand: string
  private readonly archiveCommand: string
  private readonly purgeCommand: string
  private readonly countStatesCommand: string
  public functions: Function[]
  private stopped = false
  private readonly manager: Manager

  constructor (private readonly db: DatabaseInterface, private readonly config: BossConfig) {
    super()

    this.db = db
    this.config = config
    this.manager = config.manager

    this.maintenanceIntervalSeconds = config.maintenanceIntervalSeconds

    this.monitorStates = config.monitorStateIntervalSeconds !== null

    if (this.monitorStates) {
      this.monitorIntervalSeconds = config.monitorStateIntervalSeconds
    }

    this.expireCommand = plans.expire(config.schema)
    this.archiveCommand = plans.archive(config.schema)
    this.purgeCommand = plans.purge(config.schema)
    this.countStatesCommand = plans.countStates(config.schema)

    this.functions = [
      this.expire,
      this.archive,
      this.purge,
      this.countStates,
      this.getQueueNames
    ]
  }

  async supervise () {
    await this.manager.deleteQueue(plans.completedJobPrefix + queues.MAINTENANCE)
    await this.manager.deleteQueue(queues.MAINTENANCE)

    await this.maintenanceAsync()

    await this.manager.subscribe(queues.MAINTENANCE, { batchSize: 10 }, (jobs) => this.onMaintenance(jobs))

    if (this.monitorStates) {
      await this.manager.deleteQueue(plans.completedJobPrefix + queues.MONITOR_STATES)
      await this.manager.deleteQueue(queues.MONITOR_STATES)

      await this.monitorStatesAsync()

      await this.manager.subscribe(queues.MONITOR_STATES, { batchSize: 10 }, (jobs) => this.onMonitorStates(jobs))
    }
  }

  async maintenanceAsync () {
    const options = {
      startAfter: this.maintenanceIntervalSeconds,
      retentionSeconds: this.maintenanceIntervalSeconds * 2,
      singletonKey: queues.MAINTENANCE,
      retryLimit: 5,
      retryBackoff: true
    }

    await this.manager.publish(queues.MAINTENANCE, null, options)
  }

  async monitorStatesAsync () {
    const options = {
      startAfter: this.monitorIntervalSeconds,
      retentionSeconds: this.monitorIntervalSeconds * 2,
      singletonKey: queues.MONITOR_STATES
    }

    await this.manager.publish(queues.MONITOR_STATES, null, options)
  }

  async onMaintenance (jobs) {
    try {
      this.assertTestThrow('__test__throw_maint')

      const started = Date.now()

      this.emitValue(events.expired, await this.expire())
      this.emitValue(events.archived, await this.archive())
      this.emitValue(events.deleted, await this.purge())

      await this.manager.complete(jobs.map(j => j.id))

      const ended = Date.now()

      const maintenance: MaintenanceEvent = {
        count: jobs.length,
        ms: ended - started
      }

      this.emit('maintenance', maintenance)
    } catch (err) {
      this.emit(events.error, err)
    }

    if (!this.stopped) {
      await this.maintenanceAsync()
    }
  }

  emitValue (event: string, value: number) {
    if (value > 0) {
      this.emit(event, value)
    }
  }

  async onMonitorStates (jobs) {
    try {
      this.assertTestThrow('__test__throw_monitor')

      const states = await this.countStates()

      this.emit(events.monitorStates, states)

      await this.manager.complete(jobs.map(j => j.id))
    } catch (err) {
      this.emit(events.error, err)
    }

    if (!this.stopped && this.monitorStates) {
      await this.monitorStatesAsync()
    }
  }

  async stop () {
    if (!this.stopped) {
      this.stopped = true
    }
  }

  async countStates () {
    interface StateCountQueryResult {
      name: string
      state: string
      size: string
    }

    type StateCount = Record<keyof typeof plans.states, number>

    const stateCountDefault = Object
      .keys(plans.states)
      .reduce((acc, key) => Object.assign(acc, { [key]: 0 }), {} as StateCount)

    const counts = await this.db.executeSql<StateCountQueryResult>(this.countStatesCommand)

    const states = counts.rows.reduce((acc, item) => {
      if (item.name) {
        acc.queues[item.name] = acc.queues[item.name] || { ...stateCountDefault }
      }

      const queue = item.name ? acc.queues[item.name] : acc
      const state = item.state || 'all'

      // parsing int64 since pg returns it as string
      queue[state] = parseFloat(item.size)

      return acc
    }, { ...stateCountDefault, queues: {} as Record<string, StateCount> })

    return states
  }

  async expire () {
    const { rowCount } = await this.db.executeSql(this.expireCommand)
    return rowCount
  }

  async archive () {
    const { rowCount } = await this.db.executeSql(this.archiveCommand, [this.config.archiveInterval])
    return rowCount
  }

  async purge () {
    const { rowCount } = await this.db.executeSql(this.purgeCommand, [this.config.deleteInterval])
    return rowCount
  }

  getQueueNames () {
    return queues
  }

  private assertTestThrow (key: string) {
    if (key in this.config && this.config[key]) {
      throw new Error(key)
    }
  }
}

export = Boss
