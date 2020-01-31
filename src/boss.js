const EventEmitter = require('events')
const plans = require('./plans')

const queues = {
  MAINT: '__pgboss__maintenance',
  MONITOR_STATES: '__pgboss__monitor-states'
}

const events = {
  error: 'error',
  archived: 'archived',
  deleted: 'deleted',
  expired: 'expired',
  monitorStates: 'monitor-states'
}

class Boss extends EventEmitter {
  constructor (db, config) {
    super()

    this.db = db
    this.config = config

    this.maintenanceIntervalSeconds = config.maintenanceInterval < 1000 ? 1 : config.maintenanceInterval / 1000

    this.monitorStates = !!config.monitorStateInterval

    if (this.monitorStates) {
      this.monitorIntervalSeconds = config.monitorStateInterval < 1000 ? 1 : config.monitorStateInterval / 1000
    }

    this.timers = {}
    this.events = events

    this.expireCommand = plans.expire(config.schema)
    this.archiveCommand = plans.archive(config.schema)
    this.purgeCommand = plans.purge(config.schema)
    this.countStatesCommand = plans.countStates(config.schema)

    this.functions = [
      this.expire,
      this.archive,
      this.purge,
      this.countStates
    ]
  }

  async supervise () {
    await this.config.manager.subscribe(queues.MAINT, { batchSize: 999 }, () => this.onMaintenance())
    await this.config.manager.publishAfter(queues.MAINT, null, null, this.maintenanceIntervalSeconds)

    if (this.monitorStates) {
      await this.config.manager.subscribe(queues.MONITOR_STATES, { batchSize: 999 }, () => this.onMonitorStates())
      await this.config.manager.publishAfter(queues.MONITOR_STATES, null, null, this.monitorIntervalSeconds)
    }
  }

  async onMaintenance () {
    try {
      await this.expire()
      await this.archive()
      await this.purge()
    } catch (err) {
      this.emit(events.error, err)
    }

    if (!this.stopped) {
      await this.config.manager.publishAfter(queues.MAINT, null, null, this.maintenanceIntervalSeconds)
    }
  }

  async onMonitorStates () {
    try {
      await this.countStates()
    } catch (err) {
      this.emit(events.error, err)
    }

    if (!this.stopped && this.monitorStates) {
      await this.config.manager.publishAfter(queues.MONITOR_STATES, null, null, this.monitorIntervalSeconds)
    }
  }

  async stop () {
    if (!this.stopped) {
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

    this.emit(events.monitorStates, states)

    return states
  }

  async expire () {
    const result = await this.db.executeSql(this.expireCommand)

    if (result.rowCount) {
      this.emit(events.expired, result.rowCount)
    }

    return result.rowCount
  }

  async archive () {
    const result = await this.db.executeSql(this.archiveCommand, [this.config.archiveCompletedJobsEvery])

    if (result.rowCount) {
      this.emit(events.archived, result.rowCount)
    }

    return result.rowCount
  }

  async purge () {
    const result = await this.db.executeSql(this.purgeCommand, [this.config.deleteArchivedJobsEvery])

    if (result.rowCount) {
      this.emit(events.deleted, result.rowCount)
    }

    return result.rowCount
  }
}

module.exports = Boss
