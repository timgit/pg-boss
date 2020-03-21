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
  monitorStates: 'monitor-states',
  maintenance: 'maintenance'
}

class Boss extends EventEmitter {
  constructor (db, config) {
    super()

    this.db = db
    this.config = config
    this.maintenanceIntervalSeconds = config.maintenanceIntervalSeconds
    this.monitorStates = config.monitorStateIntervalSeconds !== null

    if (this.monitorStates) {
      this.monitorIntervalSeconds = config.monitorStateIntervalSeconds
    }

    this.events = events

    this.expireCommand = plans.expire(config.schema)
    this.archiveCommand = plans.archive(config.schema)
    this.purgeCommand = plans.purge(config.schema)
    this.countStatesCommand = plans.countStates(config.schema)

    this.functions = [
      this.expire,
      this.archive,
      this.purge,
      this.countStates,
      this.getQueueNames
    ]
  }

  async supervise () {
    await this.config.manager.deleteQueue(queues.MAINT)
    await this.maintenanceAsync()
    await this.config.manager.subscribe(queues.MAINT, { batchSize: 10 }, (jobs) => this.onMaintenance(jobs))

    if (this.monitorStates) {
      await this.config.manager.deleteQueue(queues.MONITOR_STATES)
      await this.monitorStatesAsync()
      await this.config.manager.subscribe(queues.MONITOR_STATES, { batchSize: 10 }, (jobs) => this.onMonitorStates(jobs))
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
      if (this.config.__test__throw_maint) {
        throw new Error('__test__throw_maint')
      }

      const started = Date.now()

      this.emitValue(events.expired, await this.expire())
      this.emitValue(events.archived, await this.archive())
      this.emitValue(events.deleted, await this.purge())

      await this.config.manager.complete(jobs.map(j => j.id))

      const ended = Date.now()

      this.emit('maintenance', { count: jobs.length, ms: ended - started })
    } catch (err) {
      this.emit(events.error, err)
    }

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
      if (this.config.__test__throw_monitor) {
        throw new Error('__test__throw_monitor')
      }

      const states = await this.countStates()

      this.emit(events.monitorStates, states)

      await this.config.manager.complete(jobs.map(j => j.id))
    } catch (err) {
      this.emit(events.error, err)
    }

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
    const { rowCount } = await this.db.executeSql(this.archiveCommand, [this.config.archiveInterval])
    return rowCount
  }

  async purge () {
    const { rowCount } = await this.db.executeSql(this.purgeCommand, [this.config.deleteInterval])
    return rowCount
  }

  getQueueNames () {
    return queues
  }
}

module.exports = Boss
