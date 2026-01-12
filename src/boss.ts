import EventEmitter from 'node:events'
import type Manager from './manager.js'
import * as plans from './plans.js'
import { unwrapSQLResult } from './tools.js'
import * as types from './types.js'

const events = {
  error: 'error',
  warning: 'warning'
}

const WARNINGS = {
  SLOW_QUERY: { seconds: 30, message: 'Warning: slow query. Your queues and/or database server should be reviewed' },
  LARGE_QUEUE: { size: 10_000, message: 'Warning: large queue backlog. Your queue should be reviewed' }
}

class Boss extends EventEmitter implements types.EventsMixin {
  #stopped: boolean
  #maintaining: boolean | undefined
  #superviseInterval: NodeJS.Timeout | undefined
  #db: types.IDatabase
  #config: types.ResolvedConstructorOptions
  #manager: Manager

  events = events

  constructor (
    db: types.IDatabase,
    manager: Manager,
    config: types.ResolvedConstructorOptions
  ) {
    super()

    this.#db = db
    this.#config = config
    this.#manager = manager
    this.#stopped = true

    if (config.warningSlowQuerySeconds) {
      WARNINGS.SLOW_QUERY.seconds = config.warningSlowQuerySeconds
    }

    if (config.warningQueueSize) {
      WARNINGS.LARGE_QUEUE.size = config.warningQueueSize
    }
  }

  async start () {
    if (this.#stopped) {
      this.#superviseInterval = setInterval(
        () => this.#onSupervise(),
        this.#config.superviseIntervalSeconds! * 1000
      )
      this.#stopped = false
    }
  }

  async stop () {
    if (!this.#stopped) {
      if (this.#superviseInterval) clearInterval(this.#superviseInterval)
      this.#stopped = true
    }
  }

  async #executeSql (sql: string) {
    const started = Date.now()

    const result = unwrapSQLResult(await this.#db.executeSql(sql))

    const elapsed = (Date.now() - started) / 1000

    if (
      elapsed > WARNINGS.SLOW_QUERY.seconds ||
      this.#config.__test__warn_slow_query
    ) {
      this.emit(events.warning, {
        message: WARNINGS.SLOW_QUERY.message,
        data: { elapsed, sql },
      })
    }

    return result
  }

  async #executeQuery (query: plans.SqlQuery) {
    const started = Date.now()

    const result = unwrapSQLResult(await this.#db.executeSql(query.text, query.values))

    const elapsed = (Date.now() - started) / 1000

    if (
      elapsed > WARNINGS.SLOW_QUERY.seconds ||
      this.#config.__test__warn_slow_query
    ) {
      this.emit(events.warning, {
        message: WARNINGS.SLOW_QUERY.message,
        data: { elapsed, sql: query.text, values: query.values },
      })
    }

    return result
  }

  async #onSupervise () {
    try {
      if (this.#stopped) return
      if (this.#maintaining) return
      if (this.#config.__test__throw_maint) { throw new Error(this.#config.__test__throw_maint) }

      this.#maintaining = true

      const queues = await this.#manager.getQueues()

      !this.#stopped && (await this.supervise(queues))
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.#maintaining = false
    }
  }

  async supervise (value?: string | types.QueueResult[]) {
    let queues: types.QueueResult[]

    if (Array.isArray(value)) {
      queues = value
    } else {
      queues = await this.#manager.getQueues(value)
    }

    const queueGroups = queues.reduce<
      Record<string, { table: string; queues: types.Queue[] }>
    >((acc, q) => {
      const { table } = q
      acc[table] = acc[table] || { table, queues: [] }
      acc[table].queues.push(q)
      return acc
    }, {})

    for (const queueGroup of Object.values(queueGroups)) {
      const { table, queues } = queueGroup
      const names = queues.map((i) => i.name)

      while (names.length) {
        const chunk = names.splice(0, 100)

        await this.#monitor(table, chunk)
        await this.#maintain(table, chunk)
      }
    }
  }

  async #monitor (table: string, names: string[]) {
    const command = plans.trySetQueueMonitorTime(
      this.#config.schema,
      names,
      this.#config.monitorIntervalSeconds
    )
    const { rows } = await this.#executeQuery(command)

    if (rows.length) {
      const queues = rows.map((q) => q.name)

      const cacheStatsSql = plans.cacheQueueStats(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
      const { rows: rowsCacheStats } = await this.#executeSql(cacheStatsSql)
      const warnings = rowsCacheStats.filter(i => i.queuedCount > (i.warningQueueSize || WARNINGS.LARGE_QUEUE.size))

      for (const warning of warnings) {
        this.emit(events.warning, {
          message: WARNINGS.LARGE_QUEUE.message,
          data: warning,
        })
      }

      const sql = plans.failJobsByTimeout(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
      await this.#executeSql(sql)
    }
  }

  async #maintain (table: string, names: string[]) {
    const command = plans.trySetQueueDeletionTime(
      this.#config.schema,
      names,
      this.#config.maintenanceIntervalSeconds
    )
    const { rows } = await this.#executeQuery(command)

    if (rows.length) {
      const queues = rows.map((q) => q.name)
      const sql = plans.deletion(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
      await this.#executeSql(sql)
    }
  }
}

export default Boss
