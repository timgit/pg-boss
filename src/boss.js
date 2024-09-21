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

      const queues = await this.#manager.getQueues()

      for (const queue of queues) {
        !this.#stopped && await this.maintain(queue)
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.#maintaining = false
    }
  }

  async maintain (value) {
    let queues

    if (!value) {
      queues = await this.#manager.getQueues()
    } if (typeof value === 'string') {
      queues = await this.#manager.getQueues(value)
    } else if (typeof value === 'object') {
      queues = [value]
    }

    for (const queue of queues) {
      // todo: group queries by table
      await this.#monitorActive(queue)
      await this.#dropCompleted(queue)
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
    const command = plans.trySetQueueDeletionTime(this.#config.schema, queue.name, this.#config.maintenanceIntervalSeconds)
    const { rows } = await this.#db.executeSql(command)

    if (rows.length) {
      const sql = plans.deletion(this.#config.schema, queue.table, queue.deleteAfterSeconds)
      await this.#db.executeSql(sql)
    }
  }
}

module.exports = Boss
