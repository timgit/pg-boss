import { CronExpressionParser } from 'cron-parser'
import EventEmitter from 'node:events'

import * as Attorney from './attorney.ts'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import * as types from './types.ts'

export const QUEUES = {
  SEND_IT: '__pgboss__send-it' as const
}

const EVENTS = {
  error: 'error',
  schedule: 'schedule',
  warning: 'warning'
}

const WARNINGS = {
  CLOCK_SKEW: {
    message: 'Warning: Clock skew between this instance and the database server. This will not break scheduling, but is emitted any time the skew exceeds 60 seconds.'
  }
}

export type JobConfig = {
  [QUEUES.SEND_IT]: {
    input: types.Request<types.JobsConfig, string>
  }
}

class Timekeeper<C extends types.JobsConfig & JobConfig, EC extends types.EventConfig<C>> extends EventEmitter implements types.EventsMixin {
  db: types.IDatabase
  config: types.ResolvedConstructorOptions
  manager: Manager<C, EC>

  private stopped = true
  private cronMonitorInterval: NodeJS.Timeout | null | undefined
  private skewMonitorInterval: NodeJS.Timeout | null | undefined
  private timekeeping: boolean | undefined

  clockSkew = 0
  events = EVENTS

  constructor (db: types.IDatabase, manager: Manager<C, EC>, config: types.ResolvedConstructorOptions) {
    super()

    this.db = db
    this.config = config
    this.manager = manager
  }

  async start () {
    this.stopped = false

    await this.cacheClockSkew()
    await this.manager.createQueue(QUEUES.SEND_IT)

    const options = {
      pollingIntervalSeconds: this.config.cronWorkerIntervalSeconds,
      batchSize: 50
    }

    await this.manager.work(QUEUES.SEND_IT, options, (jobs) => this.onSendIt(jobs))

    setImmediate(() => this.onCron())

    this.cronMonitorInterval = setInterval(async () => await this.onCron(), this.config.cronMonitorIntervalSeconds! * 1000)
    this.skewMonitorInterval = setInterval(async () => await this.cacheClockSkew(), this.config.clockMonitorIntervalSeconds! * 1000)
  }

  async stop () {
    if (this.stopped) {
      return
    }

    this.stopped = true

    await this.manager.offWork(QUEUES.SEND_IT, { wait: true })

    if (this.skewMonitorInterval) {
      clearInterval(this.skewMonitorInterval)
      this.skewMonitorInterval = null
    }

    if (this.cronMonitorInterval) {
      clearInterval(this.cronMonitorInterval)
      this.cronMonitorInterval = null
    }
  }

  async cacheClockSkew () {
    let skew = 0

    try {
      if (this.config.__test__force_clock_monitoring_error) {
        throw new Error(this.config.__test__force_clock_monitoring_error)
      }

      const { rows } = await this.db.executeSql(plans.getTime())

      const local = Date.now()

      const dbTime = parseFloat(rows[0].time)

      skew = dbTime - local

      const skewSeconds = Math.abs(skew) / 1000

      if (skewSeconds >= 60 || this.config.__test__force_clock_skew_warning) {
        this.emit(this.events.warning, { message: WARNINGS.CLOCK_SKEW.message, data: { seconds: skewSeconds, direction: skew > 0 ? 'slower' : 'faster' } })
      }
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      this.clockSkew = skew
    }
  }

  async onCron () {
    try {
      if (this.stopped || this.timekeeping) return

      if (this.config.__test__force_cron_monitoring_error) {
        throw new Error(this.config.__test__force_cron_monitoring_error)
      }

      this.timekeeping = true

      const sql = plans.trySetCronTime(this.config.schema, this.config.cronMonitorIntervalSeconds)

      if (!this.stopped) {
        const { rows } = await this.db.executeSql(sql)

        if (!this.stopped && rows.length === 1) {
          await this.cron()
        }
      }
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      this.timekeeping = false
    }
  }

  async cron () {
    const schedules = await this.getSchedules()

    const scheduled = schedules
      .filter(i => this.shouldSendIt(i.cron, i.timezone))
      .map(({ name, key, data, options }): types.JobInsert => ({ data: { name, data, options }, singletonKey: `${name}__${key}`, singletonSeconds: 60 }))

    if (scheduled.length > 0 && !this.stopped) {
      await this.manager.insert(QUEUES.SEND_IT, scheduled)
    }
  }

  shouldSendIt (cron: string, tz: string) {
    const interval = CronExpressionParser.parse(cron, { tz, strict: false })

    const prevTime = interval.prev()

    const databaseTime = Date.now() + this.clockSkew

    const prevDiff = (databaseTime - prevTime.getTime()) / 1000

    return prevDiff < 60
  }

  private async onSendIt (jobs: types.Job<types.Request<types.JobsConfig, string>>[]): Promise<void> {
    await Promise.allSettled(jobs.map(({ data }) => this.manager.send(data as types.Job<types.Request<types.JobsConfig, string>>))) // The type safety is partially ensured at the `schedule` function. The developer using this library will have to ensure that types are backwards compatible.
  }

  async getSchedules<N extends types.JobNames<C>>(name?: N, key = '') : Promise<types.Schedule<C, N>[]> {
    let sql = plans.getSchedules(this.config.schema)
    let params: unknown[] = []

    if (name) {
      sql = plans.getSchedulesByQueue(this.config.schema)
      params = [name, key]
    }

    const { rows } = await this.db.executeSql(sql, params)

    return rows
  }

  async schedule<N extends types.JobNames<C>>(name: N, cron: string, data?: types.JobInput<C, N>, options: types.ScheduleOptions = {}): Promise<void> {
    const { tz = 'UTC', key = '', ...rest } = options

    CronExpressionParser.parse(cron, { tz, strict: false })

    Attorney.checkSendArgs([name, data, { ...rest }])
    Attorney.assertKey(key)

    try {
      const sql = plans.schedule(this.config.schema)
      await this.db.executeSql(sql, [name, key, cron, tz, data, options])
    } catch (err: any) {
      if (err.message.includes('foreign key')) {
        err.message = `Queue ${name} not found`
      }

      throw err
    }
  }

  async unschedule<N extends types.JobNames<C>>(name: N, key = ''): Promise<void> {
    const sql = plans.unschedule(this.config.schema)
    await this.db.executeSql(sql, [name, key])
  }
}

export default Timekeeper
