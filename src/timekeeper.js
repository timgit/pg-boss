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
    const ok = await this.checkSkew()

    if (ok) {
      await this.watch()
    }

    this.monitor()
  }

  monitor () {
    const EVERY_TEN_MINUTES = 1000 * 60 * 10

    this.monitorInterval = setInterval(async () => {
      const ok = await this.checkSkew()

      if (ok && !this.watching) {
        console.log('pgboss: clock skew recovered.  Watching for cron')
        await this.watch()
      } else if (!ok && this.watching) {
        await this.unwatch()
      }
    }, EVERY_TEN_MINUTES)
  }

  async watch () {
    await this.manager.subscribe(queues.CRON, (job) => this.onCron(job))
    await this.manager.subscribe(queues.SEND_IT, { teamSize: 50, teamConcurrency: 5 }, (job) => this.onSendIt(job))

    await this.cronMonitorAsync()

    this.watching = true
  }

  async unwatch () {
    await this.manager.unsubscribe(queues.CRON)
    await this.manager.unsubscribe(queues.SEND_IT)

    this.watching = false
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

  async cronMonitorAsync (options = {}) {
    const { startAfter } = options

    const opts = {
      singletonKey: queues.CRON,
      singletonSeconds: 60,
      startAfter,
      retryLimit: 2
    }

    await this.manager.publish(queues.CRON, null, opts)
  }

  async onCron () {
    try {
      const items = await this.getSchedules()

      const sending = items.filter(i => this.shouldSendIt(i.schedule, i.options.timezone))

      if (sending.length) {
        await Promise.map(sending, it => this.send(it), { concurrency: 5 })
      }
    } catch (err) {
      this.emit(this.events.error, err)
    }

    await this.cronMonitorAsync({ startAfter: 30 })
  }

  shouldSendIt (cron, tz) {
    const interval = cronParser.parseExpression(cron, { tz })

    const prevTime = interval.prev()

    const prevDiff = (Date.now() - prevTime.getTime()) / 1000

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
    const { name, data } = job.data
    await this.manager.publish(name, data)
  }

  async checkSkew () {
    const start = Date.now()

    const { rows } = await this.db.executeSql(this.getTimeCommand)

    const end = Date.now()

    const latency = end - start

    const dbTime = parseInt(rows[0].time) - (latency / 2)

    const skew = Math.round(Math.abs(dbTime - start) / 1000)

    if (skew >= 60) {
      Attorney.warnClockSkew(`Skew: ${skew} seconds.`)
    }

    return skew < 60
  }

  async getSchedules () {
    const { rows } = await this.db.executeSql(this.getSchedulesCommand)
    return rows
  }

  async schedule (name, schedule, data, options = {}) {
    const { timezone } = options
    const values = [name, schedule, timezone || 'UTC', data, options]
    const { rowCount } = await this.db.executeSql(this.scheduleCommand, values)
    return rowCount
  }

  async unschedule (name) {
    const { rowCount } = await this.db.executeSql(this.unscheduleCommand, [name])
    return rowCount
  }
}

module.exports = Timekeeper
