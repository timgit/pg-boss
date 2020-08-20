const Promise = require('bluebird')
const EventEmitter = require('events')
const plans = require('./plans')
const cronParser = require('cron-parser')
const Attorney = require('./attorney')

const queues = {
  CRON: '__pgboss__cron',
  SEND_IT: '__pgboss__send-it'
}

const events = {
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

    this.events = events

    this.getTimeCommand = plans.getTime(config.schema)
    this.getSchedulesCommand = plans.getSchedules(config.schema)
    this.scheduleCommand = plans.schedule(config.schema)
    this.unscheduleCommand = plans.unschedule(config.schema)
    this.getCronTimeCommand = plans.getCronTime(config.schema)
    this.setCronTimeCommand = plans.setCronTime(config.schema)

    this.functions = [
      this.schedule,
      this.unschedule,
      this.getSchedules
    ]
  }

  async start () {
    await this.cacheClockSkew()

    if (this.config.archiveSeconds >= 60) {
      await this.watch()
      this.cronMonitorInterval = setInterval(async () => await this.monitorCron(), this.cronMonitorIntervalMs)
    }

    this.skewMonitorInterval = setInterval(async () => await this.cacheClockSkew(), this.skewMonitorIntervalMs)

    this.stopped = false
  }

  async stop () {
    if (!this.stopped) {
      this.stopped = true

      if (this.skewMonitorInterval) {
        clearInterval(this.skewMonitorInterval)
        this.skewMonitorInterval = null
      }

      if (this.cronMonitorInterval) {
        clearInterval(this.cronMonitorInterval)
        this.cronMonitorInterval = null
      }
    }
  }

  async monitorCron () {
    const { secondsAgo } = await this.getCronTime()

    if (secondsAgo > 60) {
      await this.cronMonitorAsync()
    }
  }

  async cacheClockSkew () {
    const { rows } = await this.db.executeSql(this.getTimeCommand)

    const local = Date.now()

    const dbTime = parseFloat(rows[0].time)

    const skew = dbTime - local

    const skewSeconds = Math.abs(skew) / 1000

    if (skewSeconds >= 60 || this.config.__test__force_clock_skew_warning) {
      Attorney.warnClockSkew(`Instance clock is ${skewSeconds}s ${skew > 0 ? 'slower' : 'faster'} than database.`)
    }

    this.clockSkew = skew
  }

  async watch () {
    await this.manager.subscribe(queues.CRON, { newJobCheckIntervalSeconds: 4 }, (job) => this.onCron(job))
    await this.manager.subscribe(queues.SEND_IT, { newJobCheckIntervalSeconds: 4, teamSize: 50, teamConcurrency: 5 }, (job) => this.onSendIt(job))

    await this.cronMonitorAsync()
  }

  async cronMonitorAsync () {
    const opts = {
      retryLimit: 2,
      retentionSeconds: 60
    }

    await this.manager.publishDebounced(queues.CRON, null, opts, 60)
  }

  async onCron () {
    if (this.stopped) {
      return
    }

    try {
      if (this.config.__test__throw_clock_monitoring) {
        throw new Error('clock monitoring error')
      }

      const items = await this.getSchedules()

      const sending = items.filter(i => this.shouldSendIt(i.cron, i.timezone))

      if (sending.length) {
        await Promise.map(sending, it => this.send(it), { concurrency: 5 })
      }

      await this.setCronTime()
    } catch (err) {
      this.emit(this.events.error, err)
    }

    await this.cronMonitorAsync()
  }

  shouldSendIt (cron, tz) {
    const interval = cronParser.parseExpression(cron, { tz })

    const prevTime = interval.prev()

    const databaseTime = Date.now() + this.clockSkew

    const prevDiff = (databaseTime - prevTime.getTime()) / 1000

    return prevDiff < 60
  }

  async send (job) {
    const options = {
      singletonKey: job.name,
      singletonSeconds: 60
    }

    await this.manager.publish(queues.SEND_IT, job, options)
  }

  async onSendIt (job) {
    const { name, data, options } = job.data
    await this.manager.publish(name, data, options)
  }

  async getSchedules () {
    const { rows } = await this.db.executeSql(this.getSchedulesCommand)
    return rows
  }

  async schedule (name, cron, data, options = {}) {
    const { tz = 'UTC' } = options

    cronParser.parseExpression(cron, { tz })

    // validation pre-check
    Attorney.checkPublishArgs([name, data, options], this.config)

    const values = [name, cron, tz, data, options]

    const { rowCount } = await this.db.executeSql(this.scheduleCommand, values)

    return rowCount
  }

  async unschedule (name) {
    const { rowCount } = await this.db.executeSql(this.unscheduleCommand, [name])
    return rowCount
  }

  async setCronTime () {
    await this.db.executeSql(this.setCronTimeCommand)
  }

  async getCronTime () {
    const { rows } = await this.db.executeSql(this.getCronTimeCommand)

    let { cron_on: cronOn, seconds_ago: secondsAgo } = rows[0]

    secondsAgo = secondsAgo !== null ? parseFloat(secondsAgo) : 61

    return { cronOn, secondsAgo }
  }
}

module.exports = Timekeeper
