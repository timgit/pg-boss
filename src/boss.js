const EventEmitter = require('node:events')
const plans = require('./plans')

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
      if (this.stopped) return
      if (this.maintaining) return
      if (this.config.__test__throw_maint) throw new Error(this.config.__test__throw_maint)

      this.maintaining = true

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
      !this.stopped && await this.monitor(queue)
      !this.stopped && await this.archive(queue)

      if (this.stopped) break
    }

    !this.stopped && await this.drop()
  }

  async stop () {
    if (!this.stopped) {
      if (this.superviseInterval) clearInterval(this.superviseInterval)
      if (this.monitorInterval) clearInterval(this.monitorInterval)

      this.stopped = true
    }
  }

  async monitor (queue) {
    const command = plans.trySetQueueMonitorTime(this.config.schema, queue.name, this.config.monitorIntervalSeconds)
    const { rows } = await this.db.executeSql(command)

    if (rows.length) {
      const sql = plans.failJobsByTimeout(this.config.schema, queue)
      await this.db.executeSql(sql)

      const cacheStatsSql = plans.cacheQueueStats(this.config.schema, queue)
      await this.db.executeSql(cacheStatsSql)
    }
  }

  async archive (queue) {
    const { name, table, archive } = queue

    const command = plans.trySetQueueArchiveTime(this.config.schema, name, this.config.archiveIntervalSeconds)
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
