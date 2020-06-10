const Promise = require('bluebird')
const EventEmitter = require('events')
const plans = require('./plans')
const cronParser = require('cron-parser')

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

  async watch () {
    // todo: check current time against server time.
    // If drift is > 1 minute, warn.
    // If drift is > 5 min don't allow timekeeping

    // const dbTime = await this.getTime()

    await this.manager.subscribe(queues.CRON, { newJobCheckIntervalSeconds: 20 }, (job) => this.onCron(job))
    await this.manager.subscribe(queues.SEND_IT, { newJobCheckIntervalSeconds: 60, teamSize: 50, teamConcurrency: 5 }, (job) => this.onSendIt(job))

    await this.cronMonitorAsync()
  }

  async stop () {
    if (!this.stopped) {
      this.stopped = true
    }
  }

  async cronMonitorAsync () {
    const INTERVAL = 30

    const options = {
      singletonKey: queues.CRON,
      singletonSeconds: INTERVAL,
      startAfter: INTERVAL,
      retryLimit: 2
    }

    await this.manager.publish(queues.CRON, null, options)
  }

  async onCron () {
    try {
      const items = await this.getSchedules()

      const sending = items.filter(i => this.shouldSendIt(i.schedule, i.timezone))

      if (sending.length) {
        await Promise.map(sending, it => this.send(it), { concurrency: 5 })
      }
    } catch (err) {
      this.emit(this.events.error, err)
    }

    await this.cronMonitorAsync()
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

  async getTime () {
    const { rows } = await this.db.executeSql(this.getTimeCommand)
    return rows[0]
  }

  async getSchedules () {
    const { rows } = await this.db.executeSql(this.getSchedulesCommand)
    return rows
  }

  async schedule (name, schedule, data, options) {
    const values = [name, schedule, data, options]
    const { rowCount } = await this.db.executeSql(this.scheduleCommand, values)
    return rowCount
  }

  async unschedule (name) {
    const { rowCount } = await this.db.executeSql(this.unscheduleCommand, [name])
    return rowCount
  }
}

module.exports = Timekeeper
