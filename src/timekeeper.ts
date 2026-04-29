import { CronExpressionParser } from 'cron-parser'
import EventEmitter from 'node:events'

import * as Attorney from './attorney.ts'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import { delay } from './tools.ts'
import * as types from './types.ts'
import { emitAndPersistWarning, type WarningContext } from './warning.ts'

export const QUEUES = {
  SEND_IT: '__pgboss__send-it'
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

const WARNING_TYPES = {
  CLOCK_SKEW: 'clock_skew'
} as const

function isSubMinuteCron (cron: string): boolean {
  return cron.trim().split(/\s+/).length === 6
}

function getCronIntervalSeconds (cron: string, tz: string): number {
  const interval = CronExpressionParser.parse(cron, { tz, strict: false })
  const prev = interval.prev()
  const next = interval.next()
  return Math.round((next.getTime() - prev.getTime()) / 1000)
}

class Timekeeper extends EventEmitter implements types.EventsMixin {
  db: types.IDatabase
  config: types.ResolvedConstructorOptions
  manager: Manager

  private stopped = true
  private cronMonitorInterval: NodeJS.Timeout | null | undefined
  private skewMonitorInterval: NodeJS.Timeout | null | undefined
  private timekeeping: boolean | undefined
  private _checkingSkew = false
  private schedules: types.Schedule[] = []
  private secondTickInterval: NodeJS.Timeout | null | undefined

  clockSkew = 0
  events = EVENTS

  constructor (db: types.IDatabase, manager: Manager, config: types.ResolvedConstructorOptions) {
    super()

    this.db = db
    this.config = config
    this.manager = manager
  }

  get checkingSkew (): boolean {
    return this._checkingSkew
  }

  private get warningContext (): WarningContext {
    return {
      emitter: this,
      db: this.db,
      schema: this.config.schema,
      persistWarnings: this.config.persistWarnings,
      warningEvent: this.events.warning,
      errorEvent: this.events.error
    }
  }

  async start () {
    this.stopped = false

    await this.cacheClockSkew()
    await this.manager.createQueue(QUEUES.SEND_IT)

    const options = {
      pollingIntervalSeconds: this.config.cronWorkerIntervalSeconds,
      batchSize: 50
    }

    await this.manager.work<types.Request>(QUEUES.SEND_IT, options, (jobs) => this.onSendIt(jobs))

    await this.refreshScheduleCache()
    setImmediate(() => this.onCron())

    this.cronMonitorInterval = setInterval(async () => await this.onCron(), this.config.cronMonitorIntervalSeconds! * 1000)
    this.skewMonitorInterval = setInterval(async () => await this.cacheClockSkew(), this.config.clockMonitorIntervalSeconds! * 1000)
    this.secondTickInterval = setInterval(async () => await this.onSecondTick(), 1000)
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

    if (this.secondTickInterval) {
      clearInterval(this.secondTickInterval)
      this.secondTickInterval = null
    }

    while (this.timekeeping || this._checkingSkew) {
      await delay(10)
    }
  }

  async cacheClockSkew () {
    let skew = 0

    this._checkingSkew = true

    try {
      if (this.config.__test__force_clock_monitoring_error) {
        throw new Error(this.config.__test__force_clock_monitoring_error)
      }

      if (this.config.__test__delay_clock_skew_ms) {
        await delay(this.config.__test__delay_clock_skew_ms)
      }

      const { rows } = await this.db.executeSql(plans.getTime())

      const local = Date.now()

      const dbTime = parseFloat(rows[0].time)

      skew = dbTime - local

      const skewSeconds = Math.abs(skew) / 1000

      if (skewSeconds >= 60 || this.config.__test__force_clock_skew_warning) {
        await emitAndPersistWarning(
            this.warningContext,
            WARNING_TYPES.CLOCK_SKEW,
            WARNINGS.CLOCK_SKEW.message,
            { seconds: skewSeconds, direction: skew > 0 ? 'slower' : 'faster' }
        )
      }
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      this.clockSkew = skew
      this._checkingSkew = false
    }
  }

  async onCron () {
    try {
      if (this.stopped || this.timekeeping) return

      if (this.config.__test__force_cron_monitoring_error) {
        throw new Error(this.config.__test__force_cron_monitoring_error)
      }

      this.timekeeping = true

      await this.refreshScheduleCache()

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
    const scheduled = this.schedules
        .filter(i => !isSubMinuteCron(i.cron) && this.shouldSendIt(i.cron, i.timezone))
        .map(({ name, key, data, options }): types.JobInsert => ({ data: { name, data, options }, singletonKey: `${name}__${key}`, singletonSeconds: 60 }))

    if (scheduled.length > 0 && !this.stopped) {
      await this.manager.insert(QUEUES.SEND_IT, scheduled)
    }
  }

  async onSecondTick () {
    if (this.stopped) return

    try {
      const scheduled = this.schedules
          .filter(i => isSubMinuteCron(i.cron) && this.shouldSendIt(i.cron, i.timezone, 1.5))
          .map(({ name, key, data, options, cron, timezone }): types.JobInsert => {
            const intervalSeconds = getCronIntervalSeconds(cron, timezone)
            return {
              data: { name, data, options },
              singletonKey: `${name}__${key}`,
              ...(intervalSeconds > 1 ? { singletonSeconds: Math.min(intervalSeconds, 60) } : {})
            }
          })

      if (scheduled.length > 0) {
        await this.manager.insert(QUEUES.SEND_IT, scheduled)
      }
    } catch (err) {
      this.emit(this.events.error, err)
    }
  }

  shouldSendIt (cron: string, tz: string, windowSeconds = 60) {
    const interval = CronExpressionParser.parse(cron, { tz, strict: false })

    const prevTime = interval.prev()

    const databaseTime = Date.now() + this.clockSkew

    const prevDiff = (databaseTime - prevTime.getTime()) / 1000

    return prevDiff < windowSeconds
  }

  async refreshScheduleCache (): Promise<void> {
    try {
      this.schedules = await this.getSchedules()
    } catch (err) {
      this.emit(this.events.error, err)
    }
  }

  private async onSendIt (jobs: types.Job<types.Request>[]): Promise<void> {
    await Promise.allSettled(jobs.map(({ data }) => this.manager.send(data)))
  }

  async getSchedules (name?: string, key = '') : Promise<types.Schedule[]> {
    let sql = plans.getSchedules(this.config.schema)
    let params: unknown[] = []

    if (name) {
      sql = plans.getSchedulesByQueue(this.config.schema)
      params = [name, key]
    }

    const { rows } = await this.db.executeSql(sql, params)

    return rows
  }

  async schedule (name: string, cron: string, data?: unknown, options: types.ScheduleOptions = {}): Promise<void> {
    const { tz = 'UTC', key = '', ...rest } = options

    CronExpressionParser.parse(cron, { tz, strict: false })

    Attorney.checkSendArgs([name, data, { ...rest }])
    Attorney.assertKey(key)

    try {
      const sql = plans.schedule(this.config.schema)
      await this.db.executeSql(sql, [name, key, cron, tz, data, options])
      await this.refreshScheduleCache()
    } catch (err: any) {
      if (err.message.includes('foreign key')) {
        err.message = `Queue ${name} not found`
      }

      throw err
    }
  }

  async unschedule (name: string, key = ''): Promise<void> {
    const sql = plans.unschedule(this.config.schema)
    await this.db.executeSql(sql, [name, key])
    await this.refreshScheduleCache()
  }
}

export default Timekeeper
