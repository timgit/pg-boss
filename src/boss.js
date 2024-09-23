const EventEmitter = require('node:events')
const plans = require('./plans')

const events = {
  error: 'error',
  warning: 'warning'
}

const WARNINGS = {
  SLOW_QUERY: { seconds: 30, message: 'Warning: slow query. Your queues and/or database server should be reviewed' },
  LARGE_QUEUE: { size: 10_000, mesasge: 'Warning: large queue. Your queue should be reviewed' }
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

    if (config.warningSlowQuerySeconds) {
      WARNINGS.SLOW_QUERY.seconds = config.warningSlowQuerySeconds
    }

    if (config.warningLargeQueueSize) {
      WARNINGS.LARGE_QUEUE.size = config.warningLargeQueueSize
    }
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

    if (elapsed > WARNINGS.SLOW_QUERY.seconds || this.#config.__test__warn_slow_query) {
      this.emit(events.warning, { message: WARNINGS.SLOW_QUERY.message, data: { elapsed, sql, values } })
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
      const { table, queues } = queueGroup
      const names = queues.map(i => i.name)

      while (names.length) {
        // todo: test
        const chunk = names.splice(0, 100)

        await this.#monitorActive(table, chunk)
        await this.#dropCompleted(table, chunk)
      }
    }
  }

  async #monitorActive (table, names) {
    const command = plans.trySetQueueMonitorTime(this.#config.schema, names, this.#config.monitorIntervalSeconds)
    const { rows } = await this.#executeSql(command)

    if (rows.length) {
      const warnings = rows.filter(i => i.queuedCount > (i.queueSizeWarning || WARNINGS.LARGE_QUEUE.size))

      for (const warning of warnings) {
        this.emit(events.warning, { message: WARNINGS.LARGE_QUEUE.mesasge, data: warning })
      }

      const sql = plans.failJobsByTimeout(this.#config.schema, table, names)
      await this.#executeSql(sql)

      const cacheStatsSql = plans.cacheQueueStats(this.#config.schema, table, names)
      await this.#executeSql(cacheStatsSql)
    }
  }

  async #dropCompleted (table, names) {
    const command = plans.trySetQueueDeletionTime(this.#config.schema, names, this.#config.maintenanceIntervalSeconds)
    const { rows } = await this.#executeSql(command)

    if (rows.length) {
      const sql = plans.deletion(this.#config.schema, table)
      await this.#executeSql(sql)
    }
  }
}

module.exports = Boss
