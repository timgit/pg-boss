const EventEmitter = require('events')
const plans = require('./plans')
const { states } = require('./plans')

const queues = {
  MAINTENANCE: '__pgboss__maintenance',
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
    this.manager = config.manager

    this.maintenanceIntervalSeconds = config.maintenanceIntervalSeconds

    this.monitorStates = config.monitorStateIntervalSeconds !== null

    if (this.monitorStates) {
      this.monitorIntervalSeconds = config.monitorStateIntervalSeconds
    }

    this.events = events

    this.expireCommand = plans.expire(config.schema)
    this.archiveCommand = plans.archive(config.schema)
    this.purgeCommand = plans.purge(config.schema)
    this.getMaintenanceTimeCommand = plans.getMaintenanceTime(config.schema)
    this.setMaintenanceTimeCommand = plans.setMaintenanceTime(config.schema)
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
    this.metaMonitor()

    await this.manager.deleteQueue(plans.completedJobPrefix + queues.MAINTENANCE)
    await this.manager.deleteQueue(queues.MAINTENANCE)

    await this.maintenanceAsync()

    const maintenanceSubscribeOptions = {
      newJobCheckIntervalSeconds: Math.max(1, this.maintenanceIntervalSeconds / 2)
    }

    await this.manager.subscribe(queues.MAINTENANCE, maintenanceSubscribeOptions, (job) => this.onMaintenance(job))

    if (this.monitorStates) {
      await this.manager.deleteQueue(plans.completedJobPrefix + queues.MONITOR_STATES)
      await this.manager.deleteQueue(queues.MONITOR_STATES)

      await this.monitorStatesAsync()

      const monitorStatesSubscribeOptions = {
        newJobCheckIntervalSeconds: Math.max(1, this.monitorIntervalSeconds / 2)
      }

      await this.manager.subscribe(queues.MONITOR_STATES, monitorStatesSubscribeOptions, (job) => this.onMonitorStates(job))
    }
  }

  metaMonitor () {
    this.metaMonitorInterval = setInterval(async () => {
      const { secondsAgo } = await this.getMaintenanceTime()

      if (secondsAgo > this.maintenanceIntervalSeconds * 2) {
        await this.manager.deleteQueue(queues.MAINTENANCE, { before: states.completed })
        await this.maintenanceAsync()
      }
    }, this.maintenanceIntervalSeconds * 2 * 1000)
  }

  async maintenanceAsync (options = {}) {
    const { startAfter } = options

    options = {
      startAfter,
      retentionSeconds: this.maintenanceIntervalSeconds * 4,
      singletonKey: queues.MAINTENANCE
    }

    await this.manager.publish(queues.MAINTENANCE, null, options)
  }

  async monitorStatesAsync (options = {}) {
    const { startAfter } = options

    options = {
      startAfter,
      retentionSeconds: this.monitorIntervalSeconds * 4,
      singletonKey: queues.MONITOR_STATES
    }

    await this.manager.publish(queues.MONITOR_STATES, null, options)
  }

  async onMaintenance (job) {
    try {
      if (this.config.__test__throw_maint) {
        throw new Error('__test__throw_maint')
      }

      const started = Date.now()

      this.emitValue(events.expired, await this.expire())
      this.emitValue(events.archived, await this.archive())
      this.emitValue(events.deleted, await this.purge())

      const ended = Date.now()

      await this.setMaintenanceTime()

      this.emit('maintenance', { ms: ended - started })

      if (!this.stopped) {
        await job.done() // pre-complete to bypass throttling
        await this.maintenanceAsync({ startAfter: this.maintenanceIntervalSeconds })
      }
    } catch (err) {
      this.emit(events.error, err)
      throw err
    }
  }

  async emitValue (event, value) {
    if (value > 0) {
      this.emit(event, value)
    }
  }

  async onMonitorStates (job) {
    try {
      if (this.config.__test__throw_monitor) {
        throw new Error('__test__throw_monitor')
      }

      const states = await this.countStates()

      this.emit(events.monitorStates, states)

      if (!this.stopped && this.monitorStates) {
        await job.done() // pre-complete to bypass throttling
        await this.monitorStatesAsync({ startAfter: this.monitorIntervalSeconds })
      }
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async stop () {
    if (!this.stopped) {
      if (this.metaMonitorInterval) {
        clearInterval(this.metaMonitorInterval)
      }

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
    const { rowCount } = await this.db.executeSql(this.purgeCommand, [this.config.deleteAfter])
    return rowCount
  }

  async setMaintenanceTime () {
    await this.db.executeSql(this.setMaintenanceTimeCommand)
  }

  async getMaintenanceTime () {
    const { rows } = await this.db.executeSql(this.getMaintenanceTimeCommand)

    let { maintained_on: maintainedOn, seconds_ago: secondsAgo } = rows[0]

    secondsAgo = secondsAgo !== null ? parseFloat(secondsAgo) : this.maintenanceIntervalSeconds * 10

    return { maintainedOn, secondsAgo }
  }

  getQueueNames () {
    return queues
  }
}

module.exports = Boss
