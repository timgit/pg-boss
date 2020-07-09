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
    this.monitorIntervalMs = config.clockMonitorIntervalSeconds * 1000
    this.clockSkew = 0

    this.events = events

    this.getTimeCommand = plans.getTime(config.schema)
    this.getSchedulesCommand = plans.getSchedules(config.schema)
    this.scheduleCommand = plans.schedule(config.schema)
    this.unscheduleCommand = plans.unschedule(config.schema)

    this.functions = [
      this.schedule,
      this.unschedule,
      this.getSchedules
    ]
  }

  async start () {
    await this.cacheClockSkew()
    await this.watch()

    this.monitorInterval = setInterval(() => this.cacheClockSkew(), this.monitorIntervalMs)
    this.stopped = false
  }

  async stop () {
    if (!this.stopped) {
      this.stopped = true

      if (this.monitorInterval) {
        clearInterval(this.monitorInterval)
        this.monitorInterval = null
      }
    }
  }

  async cacheClockSkew () {
    const start = Date.now()

    const { rows } = await this.db.executeSql(this.getTimeCommand)

    const end = Date.now()

    const latency = end - start

    const dbTime = Math.round(parseFloat(rows[0].time) - (latency / 2))

    const skew = dbTime - start

    const skewSeconds = Math.abs(skew) / 1000

    if (skewSeconds >= 60 || this.config.__test__force_clock_skew_warning) {
      Attorney.warnClockSkew(`Instance clock is ${skewSeconds}s ${skew > 0 ? 'slower' : 'faster'} than database.`)
    }

    this.clockSkew = skew
  }

  async watch () {
    await this.manager.subscribe(queues.CRON, (job) => this.onCron(job))
    await this.manager.subscribe(queues.SEND_IT, { teamSize: 50, teamConcurrency: 5 }, (job) => this.onSendIt(job))

    await this.cronMonitorAsync()
  }

  async cronMonitorAsync (options = {}) {
    const { startAfter } = options

    const opts = {
      singletonKey: queues.CRON,
      singletonSeconds: 60,
      retentionSeconds: 60,
      startAfter,
      retryLimit: 2
    }

    await this.manager.publish(queues.CRON, null, opts)
  }

  async onCron (job) {
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
    } catch (err) {
      this.emit(this.events.error, err)
    }

    if (!this.stopped) {
      await job.done() // pre-complete to bypass throttling
      await this.cronMonitorAsync({ startAfter: 30 })
    }
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

    const result = Attorney.checkPublishArgs([name, data, options], this.config)

    const values = [result.name, cron, tz, result.data, result.options]

    const { rowCount } = await this.db.executeSql(this.scheduleCommand, values)

    return rowCount
  }

  async unschedule (name) {
    const { rowCount } = await this.db.executeSql(this.unscheduleCommand, [name])
    return rowCount
  }
}

module.exports = Timekeeper
