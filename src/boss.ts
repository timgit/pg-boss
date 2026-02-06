import EventEmitter from 'node:events'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import { unwrapSQLResult } from './tools.ts'
import * as types from './types.ts'
import { type JobConfig as TimekeeperJobConfig } from './timekeeper.ts'

const events = {
  error: 'error',
  warning: 'warning'
}

const WARNINGS = {
  SLOW_QUERY: { seconds: 30, message: 'Warning: slow query. Your queues and/or database server should be reviewed' },
  LARGE_QUEUE: { size: 10_000, message: 'Warning: large queue backlog. Your queue should be reviewed' }
}

class Boss<C extends types.JobsConfig & TimekeeperJobConfig, EC extends types.EventConfig<C>> extends EventEmitter implements types.EventsMixin {
  #stopped: boolean
  #stopping: boolean
  #maintaining: boolean | undefined
  #superviseInterval: NodeJS.Timeout | undefined
  #db: types.IDatabase
  #config: types.ResolvedConstructorOptions
  #manager: Manager<C, EC>

  events = events

  constructor (
    db: types.IDatabase,
    manager: Manager<C, EC>,
    config: types.ResolvedConstructorOptions
  ) {
    super()

    this.#db = db
    this.#config = config
    this.#manager = manager
    this.#stopped = true
    this.#stopping = false

    if (config.warningSlowQuerySeconds) {
      WARNINGS.SLOW_QUERY.seconds = config.warningSlowQuerySeconds
    }

    if (config.warningQueueSize) {
      WARNINGS.LARGE_QUEUE.size = config.warningQueueSize
    }
  }

  async start () {
    if (this.#stopped) {
      this.#stopping = false
      this.#superviseInterval = setInterval(
        () => this.#onSupervise(),
        this.#config.superviseIntervalSeconds! * 1000
      )
      this.#stopped = false
    }
  }

  async stop () {
    if (!this.#stopped) {
      this.#stopping = true
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

  async supervise<N extends types.JobNames<C>>(value?: N | types.QueueResult<N>[]) {
    let queues: types.QueueResult<N>[]

    if (Array.isArray(value)) {
      queues = value
    } else {
      queues = await this.#manager.getQueues(value)
    }

    const queueGroups = queues.reduce<
      Record<string, { table: string; queues: types.Queue<N>[] }>
    >((acc, q) => {
      const { table } = q
      acc[table] = acc[table] || { table, queues: [] }
      acc[table].queues.push(q)
      return acc
    }, {})

    for (const queueGroup of Object.values(queueGroups)) {
      if (this.#stopping) return

      const { table, queues } = queueGroup
      const names = queues.map((i) => i.name)

      while (names.length) {
        if (this.#stopping) return

        const chunk = names.splice(0, 100)

        await this.#monitor(table, chunk)
        await this.#maintain(table, chunk)
      }
    }
  }

  async #monitor (table: string, names: string[]) {
    if (this.#stopping) return

    const command = plans.trySetQueueMonitorTime(
      this.#config.schema,
      names,
      this.#config.monitorIntervalSeconds
    )
    const { rows } = await this.#executeQuery(command)

    if (this.#stopping) return

    if (rows.length) {
      const queues = rows.map((q) => q.name)

      const cacheStatsSql = plans.cacheQueueStats(this.#config.schema, table, queues)
      const { rows: rowsCacheStats } = await this.#executeSql(cacheStatsSql)

      if (this.#stopping) return

      const warnings = rowsCacheStats.filter(i => i.queuedCount > (i.warningQueueSize || WARNINGS.LARGE_QUEUE.size))

      for (const warning of warnings) {
        this.emit(events.warning, {
          message: WARNINGS.LARGE_QUEUE.message,
          data: warning,
        })
      }

      const sql = plans.failJobsByTimeout(this.#config.schema, table, queues)
      await this.#executeSql(sql)
    }
  }

  async #maintain (table: string, names: string[]) {
    if (this.#stopping) return

    const command = plans.trySetQueueDeletionTime(
      this.#config.schema,
      names,
      this.#config.maintenanceIntervalSeconds
    )
    const { rows } = await this.#executeQuery(command)

    if (this.#stopping) return

    if (rows.length) {
      const queues = rows.map((q) => q.name)
      const sql = plans.deletion(this.#config.schema, table, queues)
      await this.#executeSql(sql)
    }
  }
}

export default Boss
