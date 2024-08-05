const EventEmitter = require('events')
const plans = require('./plans')
const { states } = require('./plans')
const { COMPLETION_JOB_PREFIX } = plans

const queues = {
  MAINTENANCE: '__pgboss__maintenance',
  MONITOR_STATES: '__pgboss__monitor-states'
}

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

    this.monitorStates = config.monitorStateIntervalSeconds !== null

    if (this.monitorStates) {
      this.monitorIntervalSeconds = config.monitorStateIntervalSeconds
    }

    this.events = events

    this.expireCommand = plans.locked(config.schema, plans.expire(config.schema))
    this.archiveCommand = plans.locked(config.schema, plans.archive(config.schema, config.archiveInterval, config.archiveFailedInterval))
    this.purgeCommand = plans.locked(config.schema, plans.purge(config.schema, config.deleteAfter))
    this.cancelDuplicateJobsCommand = plans.locked(config.schema, plans.cancelDuplicateJobs(config.schema))
    this.getMaintenanceTimeCommand = plans.getMaintenanceTime(config.schema)
    this.setMaintenanceTimeCommand = plans.setMaintenanceTime(config.schema)
    this.countStatesCommand = plans.countStates(config.schema)

    this.functions = [
      this.expire,
      this.archive,
      this.purge,
      this.cancelDuplicateJobs,
      this.countStates,
      this.getQueueNames
    ]
  }

  async supervise () {
    this.metaMonitor()

    await this.manager.deleteQueue(COMPLETION_JOB_PREFIX + queues.MAINTENANCE)
    await this.manager.deleteQueue(queues.MAINTENANCE)

    await this.maintenanceAsync()

    const maintenanceWorkOptions = {
      newJobCheckIntervalSeconds: Math.max(1, this.maintenanceIntervalSeconds / 2)
    }

    await this.manager.work(queues.MAINTENANCE, maintenanceWorkOptions, (job) => this.onMaintenance(job))

    if (this.monitorStates) {
      await this.manager.deleteQueue(COMPLETION_JOB_PREFIX + queues.MONITOR_STATES)
      await this.manager.deleteQueue(queues.MONITOR_STATES)

      await this.monitorStatesAsync()

      const monitorStatesWorkOptions = {
        newJobCheckIntervalSeconds: Math.max(1, this.monitorIntervalSeconds / 2)
      }

      await this.manager.work(queues.MONITOR_STATES, monitorStatesWorkOptions, (job) => this.onMonitorStates(job))
    }
  }

  metaMonitor () {
    this.metaMonitorInterval = setInterval(async () => {
      try {
        if (this.config.__test__throw_meta_monitor) {
          throw new Error(this.config.__test__throw_meta_monitor)
        }

        const { secondsAgo } = await this.getMaintenanceTime()

        if (secondsAgo > this.maintenanceIntervalSeconds * 2) {
          await this.manager.deleteQueue(queues.MAINTENANCE, { before: states.completed })
          await this.maintenanceAsync()
        }
      } catch (err) {
        this.emit(events.error, err)
      }
    }, this.maintenanceIntervalSeconds * 2 * 1000)
  }

  async maintenanceAsync (options = {}) {
    const { startAfter } = options

    options = {
      startAfter,
      retentionSeconds: this.maintenanceIntervalSeconds * 4,
      singletonKey: queues.MAINTENANCE,
      onComplete: false
    }

    await this.manager.send(queues.MAINTENANCE, null, options)
  }

  async monitorStatesAsync (options = {}) {
    const { startAfter } = options

    options = {
      startAfter,
      retentionSeconds: this.monitorIntervalSeconds * 4,
      singletonKey: queues.MONITOR_STATES,
      onComplete: false
    }

    await this.manager.send(queues.MONITOR_STATES, null, options)
  }

  async onMaintenance (job) {
    try {
      if (this.config.__test__throw_maint) {
        throw new Error(this.config.__test__throw_maint)
      }

      const started = Date.now()

      await this.cancelDuplicateJobs()
      await this.expire()
      await this.archive()
      await this.purge()

      const ended = Date.now()

      await this.setMaintenanceTime()

      this.emit('maintenance', { ms: ended - started })

      if (!this.stopped) {
        await this.manager.complete(job.id) // pre-complete to bypass throttling
        await this.maintenanceAsync({ startAfter: this.maintenanceIntervalSeconds })
      }
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async onMonitorStates (job) {
    try {
      if (this.config.__test__throw_monitor) {
        throw new Error(this.config.__test__throw_monitor)
      }

      const states = await this.countStates()

      this.emit(events.monitorStates, states)

      if (!this.stopped && this.monitorStates) {
        await this.manager.complete(job.id) // pre-complete to bypass throttling
        await this.monitorStatesAsync({ startAfter: this.monitorIntervalSeconds })
      }
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async stop () {
    if (this.config.__test__throw_stop) {
      throw new Error(this.config.__test__throw_stop)
    }

    if (!this.stopped) {
      if (this.metaMonitorInterval) {
        clearInterval(this.metaMonitorInterval)
      }

      await this.manager.offWork(queues.MAINTENANCE)

      if (this.monitorStates) {
        await this.manager.offWork(queues.MONITOR_STATES)
      }

      this.stopped = true
    }
  }

  async countStates () {
    const stateCountDefault = { ...plans.states }

    Object.keys(stateCountDefault)
      .forEach(key => { stateCountDefault[key] = 0 })

    const counts = await this.executeSql(this.countStatesCommand)

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

  async cancelDuplicateJobs () {
    await this.executeSql(this.cancelDuplicateJobsCommand)
  }

  async expire () {
    await this.executeSql(this.expireCommand)
  }

  async archive () {
    await this.executeSql(this.archiveCommand)
  }

  async purge () {
    await this.executeSql(this.purgeCommand)
  }

  async setMaintenanceTime () {
    await this.executeSql(this.setMaintenanceTimeCommand)
  }

  async getMaintenanceTime () {
    if (!this.stopped) {
      const { rows } = await this.db.executeSql(this.getMaintenanceTimeCommand)

      let { maintained_on: maintainedOn, seconds_ago: secondsAgo } = rows[0]

      secondsAgo = secondsAgo !== null ? parseFloat(secondsAgo) : this.maintenanceIntervalSeconds * 10

      return { maintainedOn, secondsAgo }
    }
  }

  getQueueNames () {
    return queues
  }

  async executeSql (sql, params) {
    if (!this.stopped) {
      return await this.db.executeSql(sql, params)
    }
  }
}

module.exports = Boss
module.exports.QUEUES = queues
