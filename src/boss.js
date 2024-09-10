const EventEmitter = require('node:events')
const plans = require('./plans')
const { delay } = require('./tools')

const events = {
  error: 'error'
}

class Boss extends EventEmitter {
  constructor (db, config) {
    super()

    this.db = db
    this.config = config
    this.manager = config.manager
    this.events = events

    this.functions = [
      this.drop,
      this.maintain
    ]
  }

  async supervise () {
    this.superviseInterval = setInterval(() => this.onSupervise(), this.config.superviseIntervalSeconds * 1000)
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

      await this.maintain()
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.maintaining = false
    }
  }

  async maintain (queue) {
    const queues = await this.manager.getQueues(queue)

    for (const queue of queues) {
      !this.stopped && await this.monitor(queue.name, queue.table)
      !this.stopped && await this.archive(queue.name, queue.table, queue.archive)

      if (this.stopped) break
    }

    !this.stopped && await this.drop()
  }

  async stop () {
    if (!this.stopped) {
      if (this.__testDelayPromise) this.__testDelayPromise.abort()
      if (this.superviseInterval) clearInterval(this.superviseInterval)
      if (this.monitorInterval) clearInterval(this.monitorInterval)

      this.stopped = true
    }
  }

  async monitor (queue, table) {
    const command = plans.trySetQueueMonitorTime(this.config.schema, queue, this.config.monitorIntervalSeconds)
    const { rows } = await this.db.executeSql(command)

    if (rows.length) {
      const sql = plans.failJobsByTimeout(this.config.schema, table)
      await this.db.executeSql(sql)

      const cacheStatsSql = plans.cacheQueueStats(this.config.schema, queue, table)
      await this.db.executeSql(cacheStatsSql)
    }
  }

  async archive (queue, table, archive) {
    const command = plans.trySetQueueArchiveTime(this.config.schema, queue, this.config.archiveIntervalSeconds)
    const { rows } = await this.db.executeSql(command)

    if (rows.length) {
      const sql = plans.archive(this.config.schema, table, archive, this.config.archiveInterval, this.config.archiveFailedInterval)
      await this.db.executeSql(sql)
    }
  }

  async drop () {
    const command = plans.trySetMaintenanceTime(this.config.schema, this.config.maintenanceIntervalSeconds)
    const { rows } = await this.db.executeSql(command)

    if (rows.length) {
      const sql = plans.drop(this.config.schema, this.config.deleteAfter)
      await this.db.executeSql(sql)
    }
  }
}

module.exports = Boss
