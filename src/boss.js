const EventEmitter = require('node:events')
const plans = require('./plans')

const events = {
  error: 'error',
  warn: 'warn'
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

  async #executeSql (sql, values) {
    const started = Date.now()

    const result = await this.#db.executeSql(sql, values)

    const ended = Date.now()

    const elapsed = (ended - started) / 1000

    if (elapsed > 30 || this.#config.__test__warn_slow_query) {
      const message = 'Warning: slow query. Your queues and/or database server should be reviewed'
      this.emit(events.warn, { message, elapsed, sql, values })
    }

    return result
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

    const queueGroups = queues.reduce((acc, q) => {
      const { table } = q
      acc[table] = acc[table] || { table, queues: [] }
      acc[table].queues.push(q)
      return acc
    }, {})

    for (const queueGroup of Object.values(queueGroups)) {
      await this.#monitorActive(queueGroup)
      await this.#dropCompleted(queueGroup)
    }
  }

  async #monitorActive (queueGroup) {
    const { table, queues } = queueGroup
    const names = queues.map(i => i.name)

    const command = plans.trySetQueueMonitorTime(this.#config.schema, names, this.#config.monitorIntervalSeconds)
    const { rows } = await this.#executeSql(command)

    if (rows.length) {
      const sql = plans.failJobsByTimeout(this.#config.schema, table, names)
      await this.#executeSql(sql)

      const cacheStatsSql = plans.cacheQueueStats(this.#config.schema, table, names)
      await this.#executeSql(cacheStatsSql)
    }
  }

  async #dropCompleted (queueGroup) {
    const { table, queues } = queueGroup
    const names = queues.map(i => i.name)

    const command = plans.trySetQueueDeletionTime(this.#config.schema, names, this.#config.maintenanceIntervalSeconds)
    const { rows } = await this.#executeSql(command)

    if (rows.length) {
      const sql = plans.deletion(this.#config.schema, table)
      await this.#executeSql(sql)
    }
  }
}

module.exports = Boss
