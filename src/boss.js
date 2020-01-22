const EventEmitter = require('events')
const plans = require('./plans')

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
      this.purge
    ]
  }

  async supervise () {
    const self = this

    await monitor(this.archive, this.config.archiveCheckInterval)
    await monitor(this.purge, this.config.deleteCheckInterval)
    await monitor(this.expire, this.config.expireCheckInterval)

    if (this.config.monitorStateInterval) {
      await monitor(this.countStates, this.config.monitorStateInterval)
    }

    async function monitor (func, interval) {
      repeat()

      async function exec () {
        if (!self.stopped) {
          return func.call(self).catch(err => self.emit(events.error, err))
        }
      }

      function repeat () {
        if (!self.stopped) {
          self.timers[func.name] = setTimeout(() => exec().then(repeat), interval)
        }
      }
    }
  }

  async stop () {
    if (!this.stopped) {
      this.stopped = true
      Object.keys(this.timers).forEach(key => clearTimeout(this.timers[key]))
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
