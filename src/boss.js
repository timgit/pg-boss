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

    this.maintenanceIntervalSeconds = config.maintenanceInterval <= 1000 ? 1 : config.maintenanceInterval / 1000

    this.monitorStates = config.monitorStateInterval !== null

    if (this.monitorStates) {
      this.monitorIntervalSeconds = config.monitorStateInterval <= 1000 ? 1 : config.monitorStateInterval / 1000
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
    await this.config.manager.subscribe(queues.MAINT, { batchSize: 999 }, (jobs) => this.onMaintenance(jobs))
    await this.maintenanceAsync()

    if (this.monitorStates) {
      await this.config.manager.subscribe(queues.MONITOR_STATES, { batchSize: 999 }, (jobs) => this.onMonitorStates(jobs))
      await this.monitorStatesAsync()
    }
  }

  async maintenanceAsync () {
    await this.config.manager.publishAfter(queues.MAINT, null, null, this.maintenanceIntervalSeconds)
  }

  async monitorStatesAsync () {
    await this.config.manager.publishAfter(queues.MONITOR_STATES, null, null, this.monitorIntervalSeconds)
  }

  async onMaintenance (jobs) {
    try {
      if (this.config.__test_throw_on_maint__) {
        throw new Error('throw test')
      }

      this.emitValue(events.expired, await this.expire())
      this.emitValue(events.archived, await this.archive())
      this.emitValue(events.deleted, await this.purge())
    } catch (err) {
      this.emit(events.error, err)
    }

    // don't care if we can't complete these
    await this.config.manager.complete(jobs.map(j => j.id)).catch(() => {})

    if (!this.stopped) {
      await this.maintenanceAsync()
    }
  }

  async emitValue (event, value) {
    if (value > 0) {
      this.emit(event, value)
    }
  }

  async onMonitorStates (jobs) {
    try {
      if (this.config.__test_throw_on_monitor__) {
        throw new Error('throw test')
      }

      const states = await this.countStates()
      this.emit(events.monitorStates, states)
    } catch (err) {
      this.emit(events.error, err)
    }

    // don't care if we can't complete these
    await this.config.manager.complete(jobs.map(j => j.id)).catch(() => {})

    if (!this.stopped && this.monitorStates) {
      await this.monitorStatesAsync()
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

    return states
  }

  async expire () {
    const { rowCount } = await this.db.executeSql(this.expireCommand)
    return rowCount
  }

  async archive () {
    const { rowCount } = await this.db.executeSql(this.archiveCommand, [this.config.archiveCompletedJobsEvery])
    return rowCount
  }

  async purge () {
    const { rowCount } = await this.db.executeSql(this.purgeCommand, [this.config.deleteArchivedJobsEvery])
    return rowCount
  }
}

module.exports = Boss
