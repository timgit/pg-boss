const EventEmitter = require('node:events')
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
    this.trySetMaintenanceTimeCommand = plans.trySetMaintenanceTime(config.schema)
    this.trySetMonitorTimeCommand = plans.trySetMonitorTime(config.schema)
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

      if (this.stopped) {
        return
      }

      const { rows } = await this.db.executeSql(this.trySetMonitorTimeCommand, [this.config.monitorStateIntervalSeconds])

      if (rows.length === 1 && !this.stopped) {
        const states = await this.countStates()
        this.emit(events.monitorStates, states)
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.monitoring = false
    }
  }

  async onSupervise () {
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

      const { rows } = await this.db.executeSql(this.trySetMaintenanceTimeCommand, [this.config.maintenanceIntervalSeconds])

      if (rows.length === 1 && !this.stopped) {
        const result = await this.maintain()
        this.emit(events.maintenance, result)
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.maintaining = false
    }
  }

  async maintain () {
    const started = Date.now()

    !this.stopped && await this.expire()
    !this.stopped && await this.archive()
    !this.stopped && await this.drop()

    const ended = Date.now()

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
    const stateCountDefault = { ...plans.JOB_STATES }

    for (const key of Object.keys(stateCountDefault)) {
      stateCountDefault[key] = 0
    }

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
}

module.exports = Boss
