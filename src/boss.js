const EventEmitter = require('events')
const plans = require('./plans')

const MAINTQ = '__pgboss__maintenance'

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

    this.ops = this.functions.reduce((acc, i) => Object.assign(acc, { [i.name]: i.name }, {}))
  }

  async supervise () {
    const self = this

    await this.config.manager.deleteQueue(MAINTQ)

    await this.config.manager.subscribe(MAINTQ, async job => {
      const { op, interval } = job.data
      try {
        await this[op]()
      } catch (err) {
        this.emit(events.error, err)
      } finally {
        if (!self.stopped) {
          this.config.manager.publishAfter(MAINTQ, { op, interval }, null, interval)
        }
      }
    })

    await this.monitor(this.ops.archive, this.config.archiveCheckInterval)
    await this.monitor(this.ops.purge, this.config.deleteCheckInterval)
    await this.monitor(this.ops.expire, this.config.expireCheckInterval)

    if (this.config.monitorStateInterval) {
      await this.monitor(this.ops.countStates, this.config.monitorStateInterval)
    }
  }

  async monitor (op, interval) {
    await this.config.manager.publishAfter(MAINTQ, { op, interval }, null, interval)
  }

  async stop () {
    if (!this.stopped) {
      this.stopped = true
      await this.config.manager.deleteQueue(MAINTQ)
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
