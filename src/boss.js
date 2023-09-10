const EventEmitter = require('events')
const plans = require('./plans')
const { delay } = require('./tools')

const events = {
  error: 'error',
  monitorStates: 'monitor-states',
  maintenance: 'maintenance'
}

class Boss extends EventEmitter {
  constructor (db, config) {
    super()

    this.db = db
    this.config = config
    this.manager = config.manager

    this.maintenanceIntervalSeconds = config.maintenanceIntervalSeconds
    this.monitorStateIntervalSeconds = config.monitorStateIntervalSeconds

    this.events = events

    this.failJobsByTimeoutCommand = plans.locked(config.schema, plans.failJobsByTimeout(config.schema))
    this.archiveCommand = plans.locked(config.schema, plans.archive(config.schema, config.archiveInterval, config.archiveFailedInterval))
    this.dropCommand = plans.locked(config.schema, plans.drop(config.schema, config.deleteAfter))
    this.getMaintenanceTimeCommand = plans.getMaintenanceTime(config.schema)
    this.setMaintenanceTimeCommand = plans.setMaintenanceTime(config.schema)
    this.getMonitorTimeCommand = plans.getMonitorTime(config.schema)
    this.setMonitorTimeCommand = plans.setMonitorTime(config.schema)
    this.countStatesCommand = plans.countStates(config.schema)

    this.functions = [
      this.expire,
      this.archive,
      this.drop,
      this.countStates,
      this.maintain
    ]
  }

  async supervise () {
    this.maintenanceInterval = setInterval(() => this.onSupervise(), this.maintenanceIntervalSeconds * 1000)
  }

  async monitor () {
    this.monitorInterval = setInterval(() => this.onMonitor(), this.monitorStateIntervalSeconds * 1000)
  }

  async onMonitor () {
    let locker

    try {
      if (this.monitoring) {
        return
      }

      this.monitoring = true

      if (this.config.__test__delay_monitor) {
        await delay(this.config.__test__delay_monitor)
      }

      if (this.config.__test__throw_monitor) {
        throw new Error(this.config.__test__throw_monitor)
      }

      locker = await this.db.lock({ key: 'monitor' })

      const { secondsAgo } = await this.getMonitorTime()

      if (secondsAgo > this.monitorStateIntervalSeconds && !this.stopped) {
        const states = await this.countStates()
        this.setMonitorTime()
        this.emit(events.monitorStates, states)
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      if (locker?.locked) {
        await locker.unlock()
      }

      this.monitoring = false
    }
  }

  async onSupervise () {
    let locker

    try {
      if (this.maintaining) {
        return
      }

      this.maintaining = true

      if (this.config.__test__delay_maintenance && !this.stopped) {
        this.__testDelayPromise = delay(this.config.__test__delay_maintenance)
        await this.__testDelayPromise
      }

      if (this.config.__test__throw_maint) {
        throw new Error(this.config.__test__throw_maint)
      }

      if (this.stopped) {
        return
      }

      locker = await this.db.lock({ key: 'maintenance' })

      const { secondsAgo } = await this.getMaintenanceTime()

      if (secondsAgo > this.maintenanceIntervalSeconds) {
        const result = await this.maintain()
        this.emit(events.maintenance, result)
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      if (locker?.locked) {
        await locker.unlock()
      }

      this.maintaining = false
    }
  }

  async maintain () {
    const started = Date.now()

    !this.stopped && await this.expire()
    !this.stopped && await this.archive()
    !this.stopped && await this.drop()

    const ended = Date.now()

    await this.setMaintenanceTime()

    return { ms: ended - started }
  }

  async stop () {
    if (!this.stopped) {
      if (this.__testDelayPromise) this.__testDelayPromise.abort()
      if (this.maintenanceInterval) clearInterval(this.maintenanceInterval)
      if (this.monitorInterval) clearInterval(this.monitorInterval)

      this.stopped = true
    }
  }

  async countStates () {
    const stateCountDefault = { ...plans.states }

    Object.keys(stateCountDefault)
      .forEach(key => { stateCountDefault[key] = 0 })

    const counts = await this.db.executeSql(this.countStatesCommand)

    const states = counts.rows.reduce((acc, item) => {
      if (item.name) {
        acc.queues[item.name] = acc.queues[item.name] || { ...stateCountDefault }
      }

      const queue = item.name ? acc.queues[item.name] : acc
      const state = item.state || 'all'

      // parsing int64 since pg returns it as string
      queue[state] = parseFloat(item.size)

      return acc
    }, { ...stateCountDefault, queues: {} })

    return states
  }

  async expire () {
    await this.db.executeSql(this.failJobsByTimeoutCommand)
  }

  async archive () {
    await this.db.executeSql(this.archiveCommand)
  }

  async drop () {
    await this.db.executeSql(this.dropCommand)
  }

  async setMaintenanceTime () {
    await this.db.executeSql(this.setMaintenanceTimeCommand)
  }

  async getMaintenanceTime () {
    const { rows } = await this.db.executeSql(this.getMaintenanceTimeCommand)

    let { maintained_on: maintainedOn, seconds_ago: secondsAgo } = rows[0]

    secondsAgo = secondsAgo !== null ? parseFloat(secondsAgo) : 999_999_999

    return { maintainedOn, secondsAgo }
  }

  async setMonitorTime () {
    await this.db.executeSql(this.setMonitorTimeCommand)
  }

  async getMonitorTime () {
    const { rows } = await this.db.executeSql(this.getMonitorTimeCommand)

    let { monitored_on: monitoredOn, seconds_ago: secondsAgo } = rows[0]

    secondsAgo = secondsAgo !== null ? parseFloat(secondsAgo) : 999_999_999

    return { monitoredOn, secondsAgo }
  }
}

module.exports = Boss
