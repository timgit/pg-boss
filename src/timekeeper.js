const EventEmitter = require('events')
const plans = require('./plans')
const cronParser = require('cron-parser')
const Attorney = require('./attorney')
const pMap = require('p-map')

const queues = {
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
    this.getQueueCommand = plans.getQueueByName(config.schema)
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

    this.stopped = true
  }

  async start () {
    this.stopped = false

    // setting the archive config too low breaks the cron 60s debounce interval so don't even try
    if (this.config.archiveSeconds < 60 || this.config.archiveFailedSeconds < 60) {
      return
    }

    // cache the clock skew from the db server
    await this.cacheClockSkew()

    try {
      await this.manager.createQueue(queues.SEND_IT)
    } catch {}

    await this.manager.work(queues.SEND_IT, { newJobCheckIntervalSeconds: this.config.cronWorkerIntervalSeconds, teamSize: 50, teamConcurrency: 5 }, (job) => this.onSendIt(job))

    setImmediate(() => this.onCron())

    // create monitoring interval to make sure cron hasn't crashed
    this.cronMonitorInterval = setInterval(async () => await this.onCron(), this.cronMonitorIntervalMs)
    // create monitoring interval to measure and adjust for drift in clock skew
    this.skewMonitorInterval = setInterval(async () => await this.cacheClockSkew(), this.skewMonitorIntervalMs)
  }

  async stop () {
    if (this.stopped) {
      return
    }

    this.stopped = true

    await this.manager.offWork(queues.SEND_IT)

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
    let locker

    try {
      if (this.stopped || this.timekeeping) return

      if (this.config.__test__force_cron_monitoring_error) {
        throw new Error(this.config.__test__force_cron_monitoring_error)
      }

      this.timekeeping = true

      locker = await this.db.lock({ key: 'timekeeper' })

      const { secondsAgo } = await this.getCronTime()

      if (secondsAgo > 30) {
        await this.cron()
        await this.setCronTime()
      }
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      if (locker?.locked) {
        await locker.unlock()
      }

      this.timekeeping = false
    }
  }

  async cron () {
    const items = await this.getSchedules()

    const sending = items.filter(i => this.shouldSendIt(i.cron, i.timezone))

    if (sending.length && !this.stopped) {
      await pMap(sending, it => this.send(it), { concurrency: 5 })
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
    await this.manager.send(queues.SEND_IT, job, { singletonKey: job.name, singletonSeconds: 60 })
  }

  async onSendIt (job) {
    if (this.stopped) return
    const { name, data, options } = job.data
    await this.manager.send(name, data, options)
  }

  async getSchedules () {
    const { rows } = await this.db.executeSql(this.getSchedulesCommand)
    return rows
  }

  async schedule (name, cron, data, options = {}) {
    const { tz = 'UTC' } = options

    cronParser.parseExpression(cron, { tz })

    // validation pre-check
    Attorney.checkSendArgs([name, data, options], this.config)

    // make sure queue exists before scheduling
    const queue = await this.db.executeSql(this.getQueueCommand, [name])

    if (!queue.rows.length === 0) {
      throw new Error(`Queue '${name}' not found`)
    }

    const values = [name, cron, tz, data, options]

    const result = await this.db.executeSql(this.scheduleCommand, values)

    return result ? result.rowCount : null
  }

  async unschedule (name) {
    const result = await this.db.executeSql(this.unscheduleCommand, [name])
    return result ? result.rowCount : null
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
module.exports.QUEUES = queues
