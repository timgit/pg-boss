const EventEmitter = require('node:events')
const plans = require('./plans')
const cronParser = require('cron-parser')
const Attorney = require('./attorney')

const QUEUES = {
  SEND_IT: '__pgboss__send-it'
}

const EVENTS = {
  error: 'error',
  schedule: 'schedule'
}

class Timekeeper extends EventEmitter {
  constructor (db, config) {
    super()

    this.db = db
    this.config = config
    this.manager = config.manager
    this.skewMonitorIntervalMs = config.clockMonitorIntervalSeconds * 1000
    this.cronMonitorIntervalMs = config.cronMonitorIntervalSeconds * 1000
    this.clockSkew = 0

    this.events = EVENTS

    this.getTimeCommand = plans.getTime(config.schema)
    this.getQueueCommand = plans.getQueueByName(config.schema)
    this.getSchedulesCommand = plans.getSchedules(config.schema)
    this.scheduleCommand = plans.schedule(config.schema)
    this.unscheduleCommand = plans.unschedule(config.schema)
    this.trySetCronTimeCommand = plans.trySetCronTime(config.schema)

    this.functions = [
      this.schedule,
      this.unschedule,
      this.getSchedules
    ]

    this.stopped = true
  }

  async start () {
    // setting the archive config too low breaks the cron 60s debounce interval so don't even try
    if (this.config.archiveSeconds < 60 || this.config.archiveFailedSeconds < 60) {
      return
    }

    this.stopped = false

    await this.cacheClockSkew()

    try {
      await this.manager.createQueue(QUEUES.SEND_IT)
    } catch {}

    const options = {
      pollingIntervalSeconds: this.config.cronWorkerIntervalSeconds,
      batchSize: 50
    }

    await this.manager.work(QUEUES.SEND_IT, options, async (jobs) => { await this.manager.insert(jobs.map(i => i.data)) })

    setImmediate(() => this.onCron())

    this.cronMonitorInterval = setInterval(async () => await this.onCron(), this.cronMonitorIntervalMs)
    this.skewMonitorInterval = setInterval(async () => await this.cacheClockSkew(), this.skewMonitorIntervalMs)
  }

  async stop () {
    if (this.stopped) {
      return
    }

    this.stopped = true

    await this.manager.offWork(QUEUES.SEND_IT)

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

      const { rows } = await this.db.executeSql(this.getTimeCommand)

      const local = Date.now()

      const dbTime = parseFloat(rows[0].time)

      skew = dbTime - local

      const skewSeconds = Math.abs(skew) / 1000

      if (skewSeconds >= 60 || this.config.__test__force_clock_skew_warning) {
        Attorney.warnClockSkew(`Instance clock is ${skewSeconds}s ${skew > 0 ? 'slower' : 'faster'} than database.`)
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

      const { rows } = await this.db.executeSql(this.trySetCronTimeCommand, [this.config.cronMonitorIntervalSeconds])

      if (rows.length === 1 && !this.stopped) {
        await this.cron()
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
      .map(({ name, data, options }) =>
        ({ name: QUEUES.SEND_IT, data: { name, data, ...options }, singletonKey: name, singletonSeconds: 60 }))

    if (scheduled.length > 0 && !this.stopped) {
      await this.manager.insert(scheduled)
    }
  }

  shouldSendIt (cron, tz) {
    const interval = cronParser.parseExpression(cron, { tz })

    const prevTime = interval.prev()

    const databaseTime = Date.now() + this.clockSkew

    const prevDiff = (databaseTime - prevTime.getTime()) / 1000

    return prevDiff < 60
  }

  async getSchedules () {
    const { rows } = await this.db.executeSql(this.getSchedulesCommand)
    return rows
  }

  async schedule (name, cron, data, options = {}) {
    const { tz = 'UTC' } = options

    cronParser.parseExpression(cron, { tz })

    Attorney.checkSendArgs([name, data, options], this.config)

    const values = [name, cron, tz, data, options]

    try {
      await this.db.executeSql(this.scheduleCommand, values)
    } catch (err) {
      if (err.message.includes('foreign key')) {
        err.message = `Queue ${name} not found`
      }

      throw err
    }
  }

  async unschedule (name) {
    await this.db.executeSql(this.unscheduleCommand, [name])
  }
}

module.exports = Timekeeper
module.exports.QUEUES = QUEUES
