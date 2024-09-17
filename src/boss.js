const EventEmitter = require('node:events')
const plans = require('./plans')

const events = {
  error: 'error'
}

class Boss extends EventEmitter {
  #stopped
  #maintaining
  #superviseInterval
  #db
  #config
  #manager

  constructor (db, config) {
    super()

    this.#db = db
    this.#config = config
    this.#manager = config.manager
    this.#stopped = true

    this.events = events
    this.functions = [
      this.maintain
    ]
  }

  async start () {
    if (this.#stopped) {
      this.#superviseInterval = setInterval(() => this.#onSupervise(), this.#config.superviseIntervalSeconds * 1000)
      this.#stopped = false
    }
  }

  async stop () {
    if (!this.#stopped) {
      if (this.#superviseInterval) clearInterval(this.#superviseInterval)
      this.#stopped = true
    }
  }

  async #onSupervise () {
    try {
      if (this.#stopped) return
      if (this.#maintaining) return
      if (this.#config.__test__throw_maint) throw new Error(this.#config.__test__throw_maint)

      this.#maintaining = true

      await this.maintain()
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.#maintaining = false
    }
  }

  async maintain (queue) {
    const queues = await this.#manager.getQueues(queue)

    for (const queue of queues) {
      !this.#stopped && await this.#monitorActive(queue)
      !this.#stopped && await this.#dropCompleted(queue)

      if (this.#stopped) break
    }
  }

  async #monitorActive (queue) {
    const command = plans.trySetQueueMonitorTime(this.#config.schema, queue.name, this.#config.monitorIntervalSeconds)
    const { rows } = await this.#db.executeSql(command)

    if (rows.length) {
      const sql = plans.failJobsByTimeout(this.#config.schema, queue)
      await this.#db.executeSql(sql)

      const cacheStatsSql = plans.cacheQueueStats(this.#config.schema, queue)
      await this.#db.executeSql(cacheStatsSql)
    }
  }

  async #dropCompleted (queue) {
    const command = plans.trySetQueueDeletionTime(this.#config.schema, queue.name, this.#config.deleteIntervalSeconds)
    const { rows } = await this.#db.executeSql(command)

    if (rows.length) {
      const sql = plans.deletion(this.#config.schema, queue.table, queue.deletionSeconds)
      await this.#db.executeSql(sql)
    }
  }
}

module.exports = Boss
