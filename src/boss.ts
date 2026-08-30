import EventEmitter from 'node:events'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import { delay, unwrapSQLResult } from './tools.ts'
import * as types from './types.ts'
import { emitAndPersistWarning, type WarningContext } from './warning.ts'

const events = {
  error: 'error',
  warning: 'warning'
}

// Default thresholds and warning messages
const WARNINGS = {
  SLOW_QUERY: { seconds: 30, message: 'Warning: slow query. Your queues and/or database server should be reviewed' },
  LARGE_QUEUE: { size: 10_000, message: 'Warning: large queue backlog. Your queue should be reviewed' }
}

const WARNING_TYPES = {
  SLOW_QUERY: 'slow_query',
  QUEUE_BACKLOG: 'queue_backlog',
  INDEX_BLOAT: 'index_bloat'
} as const

// SQLSTATE 25001 (active_sql_transaction): "REINDEX CONCURRENTLY cannot run inside a transaction
// block". Raised when a user-supplied adapter wraps executeSql in a transaction — a property of the
// adapter, not of this pass, so it disables rebuilds for the life of the instance rather than
// retrying every interval.
const IN_TRANSACTION_ERROR = '25001'

class Boss extends EventEmitter implements types.EventsMixin {
  #stopped: boolean
  #stopping: boolean
  #maintaining: boolean | undefined
  #superviseInterval: NodeJS.Timeout | undefined
  #db: types.IDatabase
  #config: types.ResolvedConstructorOptions
  #manager: Manager
  readonly #slowQuerySeconds: number
  readonly #largeQueueSize: number
  // Set once a rebuild proves impossible on this connection (see IN_TRANSACTION_ERROR). Detection
  // keeps running; only the DDL is abandoned.
  #reindexUnavailable: string | null = null
  // Warn once per bloated index rather than on every pass. An index leaves the set as soon as it
  // stops qualifying — rebuilt, dropped, or refilled — so a later episode warns again.
  #warnedBloat = new Set<string>()

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
    this.#stopping = false
    this.#slowQuerySeconds = config.warningSlowQuerySeconds || WARNINGS.SLOW_QUERY.seconds
    this.#largeQueueSize = config.warningQueueSize || WARNINGS.LARGE_QUEUE.size
  }

  get maintaining (): boolean {
    return !!this.#maintaining
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
      while (this.#maintaining) {
        await delay(10)
      }
    }
  }

  get #warningContext (): WarningContext {
    return {
      emitter: this,
      db: this.#db,
      schema: this.#config.schema,
      persistWarnings: this.#config.persistWarnings,
      warningEvent: events.warning,
      errorEvent: events.error
    }
  }

  async #executeQuery (query: plans.SqlQuery | string) {
    if (typeof (query) === 'string') {
      query = { text: query, values: [] }
    }

    const started = Date.now()

    const result = unwrapSQLResult(await this.#db.executeSql(query.text, query.values))

    const elapsed = (Date.now() - started) / 1000

    if (
      elapsed > this.#slowQuerySeconds ||
      this.#config.__test__warn_slow_query
    ) {
      await emitAndPersistWarning(this.#warningContext,
        WARNING_TYPES.SLOW_QUERY,
        WARNINGS.SLOW_QUERY.message,
        { elapsed, sql: query.text, values: query.values }
      )
    }

    return result
  }

  async #onSupervise () {
    try {
      if (this.#stopped) return
      if (this.#maintaining) return
      if (this.#config.__test__throw_maint) { throw new Error(this.#config.__test__throw_maint) }

      this.#maintaining = true

      if (this.#config.__test__delay_maint_ms) {
        await delay(this.#config.__test__delay_maint_ms)
      }

      const queues = await this.#manager.getQueues()

      !this.#stopped && (await this.supervise(queues))
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.#maintaining = false
    }
  }

  async #maintainWarnings () {
    if (!this.#config.persistWarnings || !this.#config.warningRetentionDays) {
      return
    }

    const sql = plans.deleteOldWarnings(this.#config.schema, this.#config.warningRetentionDays)
    await this.#executeQuery(sql)
  }

  async #ensureQueueStatsPartitions () {
    const sql = plans.ensureQueueStatsPartitions(this.#config.schema)
    await this.#executeQuery(sql)
  }

  async #maintainQueueStats () {
    if (!this.#config.persistQueueStats || !this.#config.queueStatRetentionDays) {
      return
    }

    const sql = this.#config.noTablePartitioning
      ? plans.deleteOldQueueStats(this.#config.schema, this.#config.queueStatRetentionDays)
      : plans.dropOldQueueStatsPartitions(this.#config.schema, this.#config.queueStatRetentionDays)
    await this.#executeQuery(sql)
  }

  async supervise (value?: string | types.QueueResult[], options?: types.SuperviseOptions) {
    let queues: types.QueueResult[]

    if (Array.isArray(value)) {
      queues = value
    } else {
      queues = await this.#manager.getQueues(value)
    }

    // Ensure today's/tomorrow's partitions exist before any insertQueueStats below. Retention
    // (#maintainWarnings/#maintainQueueStats) runs at the tail. Both live here, in the public
    // supervise() path that also performs the writes, rather than in the timer-only #onSupervise
    // wrapper — so manual supervise() callers (instances run with the built-in supervisor disabled)
    // get partitions provisioned and old data pruned, not just job retention.
    if (this.#config.persistQueueStats && !this.#config.noTablePartitioning && !this.#stopping) {
      await this.#ensureQueueStatsPartitions()
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

    if (this.#stopping) return

    await this.#maintainWarnings()
    await this.#maintainQueueStats()

    // Last in the pass: a rebuild is DDL that can run for seconds, so nothing time-sensitive
    // (expiry, deletion, stats) should ever queue behind it.
    await this.#reindex(Object.keys(queueGroups), options)
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

      const cacheStatsSql = plans.cacheQueueStats(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
      const { rows: rowsCacheStats } = await this.#executeQuery(cacheStatsSql)

      if (this.#config.persistQueueStats) {
        const insertSql = plans.insertQueueStats(this.#config.schema, queues, this.#config.noAdvisoryLocks)
        await this.#executeQuery(insertSql)
      }

      if (this.#stopping) return

      // Coerce with Number(): CockroachDB returns these integer columns as strings, so a bare `>`
      // would compare lexicographically ("100" > "9" === false) and silently miss the backlog. On
      // standard Postgres these are already numbers, so Number() is a no-op.
      const warnings = rowsCacheStats.filter(i => Number(i.queuedCount) > (Number(i.warningQueueSize) || this.#largeQueueSize))

      for (const warning of warnings) {
        await emitAndPersistWarning(this.#warningContext,
          WARNING_TYPES.QUEUE_BACKLOG,
          WARNINGS.LARGE_QUEUE.message,
          warning
        )
      }

      // CockroachDB rejects the multi-mutation failJobs() CTE these use, so under noMultiMutationCte
      // route expiry through the manager's split select/delete/re-insert variants instead.
      if (this.#config.noMultiMutationCte) {
        await this.#manager.failJobsByTimeoutDistributed(table, queues)
      } else {
        const sql = plans.failJobsByTimeout(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
        await this.#executeQuery(sql)
      }

      if (this.#stopping) return

      if (this.#config.noMultiMutationCte) {
        await this.#manager.failJobsByHeartbeatDistributed(table, queues)
      } else {
        const heartbeatSql = plans.failJobsByHeartbeat(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
        await this.#executeQuery(heartbeatSql)
      }
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
      const sql = plans.deletion(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
      await this.#executeQuery(sql)

      const depSql = plans.cleanupDependencies(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
      await this.#executeQuery(depSql)
    }
  }

  // DDL runs outside the slow-query timer. A REINDEX is expected to take seconds — routing it
  // through #executeQuery would emit a bogus slow_query warning on every rebuild.
  async #executeDdl (sql: string) {
    return unwrapSQLResult(await this.#db.executeSql(sql))
  }

  #resolveReindexOptions (options?: types.SuperviseOptions): types.ReindexOptions | null {
    const setting = options && 'reindex' in options ? options.reindex : this.#config.reindex

    if (setting === false) return null
    if (setting === true || setting === undefined) return {}

    return setting
  }

  /**
   * Reports bloated job indexes and, unless disabled, rebuilds them with REINDEX INDEX
   * CONCURRENTLY. See the notes in plans.ts for why the trigger is index density rather than
   * elapsed time.
   *
   * Detection still runs where the rebuild cannot: a role that does not own the indexes, an adapter
   * that wraps queries in a transaction, and `reindex: false` all still produce the `index_bloat`
   * warning and can act on getReindexCommands(). The one exception is a backend that stores data
   * outside PostgreSQL's heap — see the noReindex gate below.
   */
  async #reindex (tables: string[], options?: types.SuperviseOptions) {
    if (this.#stopping) return

    // Skipped whole, detection included, on engines with no btree page bloat to find. Verified on
    // CockroachDB v26.2 and YugabyteDB 2025.2: CockroachDB has no pg_relation_size() at all and
    // rejects `reltuples / relpages` outright ("unsupported binary operator: <float4> / <int4>"),
    // so running the check would throw once per interval; YugabyteDB answers but reports relpages
    // and pg_relation_size as 0 for every relation, so nothing could ever match. Both store data in
    // an LSM that compacts on its own, and both reject REINDEX in either form — CockroachDB with
    // the hint "CockroachDB does not require reindexing."
    if (this.#config.noReindex) return

    const resolved = this.#resolveReindexOptions(options)
    const force = !!resolved?.force

    // An explicit force is a request to run now; everything else waits for the shared interval so
    // exactly one instance in the cluster does the work.
    if (!force) {
      const claim = plans.trySetReindexTime(this.#config.schema, this.#config.reindexIntervalSeconds)
      const { rows } = await this.#executeQuery(claim)
      if (!rows.length) return
    }

    if (this.#stopping) return

    const scope = tables.length ? tables : undefined
    const detectSql = plans.getBloatedIndexes(this.#config.schema, scope, resolved ?? undefined)
    const { rows: bloated } = await this.#executeQuery(detectSql)

    const rebuilding = resolved !== null && !this.#reindexUnavailable

    let targets: types.IndexBloat[] = []

    if (rebuilding) {
      const maxIndexBytes = resolved.maxIndexBytes ?? plans.REINDEX_DEFAULTS.maxIndexBytes
      const candidates = force
        ? (await this.#executeQuery(plans.getJobIndexes(this.#config.schema, scope))).rows
        : bloated

      targets = candidates.filter((i: types.IndexBloat) => i.owned && Number(i.bytes) <= maxIndexBytes)

      if (targets.length) {
        await this.#dropReindexLeftovers(scope)
      }
    }

    const rebuilt = new Set<string>()
    const failed = new Map<string, string>()

    for (const target of targets) {
      if (this.#stopping) return

      try {
        await this.#executeDdl(plans.reindexIndex(this.#config.schema, target.name))
        rebuilt.add(target.name)
      } catch (err) {
        const code = (err as { code?: string })?.code

        if (code === IN_TRANSACTION_ERROR) {
          this.#reindexUnavailable = (err as Error).message
          failed.set(target.name, this.#reindexUnavailable)
          // Every remaining index would fail identically — the transaction wrapper is a property of
          // the adapter, not of this index.
          break
        }

        failed.set(target.name, (err as Error).message)
      }
    }

    await this.#warnIndexBloat(bloated, rebuilt, failed, rebuilding)
  }

  // Invalid `*_ccnew` stubs from an interrupted REINDEX CONCURRENTLY. Best effort: a failure here
  // must not stop the rebuilds, since the retry's own IF EXISTS handles the common case anyway.
  async #dropReindexLeftovers (tables?: string[]) {
    try {
      const { rows } = await this.#executeQuery(plans.getReindexLeftovers(this.#config.schema, tables))

      for (const leftover of rows) {
        if (this.#stopping) return
        await this.#executeDdl(plans.dropIndexConcurrently(this.#config.schema, leftover.name))
      }
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async #warnIndexBloat (
    bloated: types.IndexBloat[],
    rebuilt: Set<string>,
    failed: Map<string, string>,
    rebuilding: boolean
  ) {
    const stillBloated = new Set<string>()

    for (const index of bloated) {
      // A rebuilt index is no longer a standing condition, and re-warning about it next episode is
      // correct, so it never enters the warned set.
      if (rebuilt.has(index.name)) continue

      stillBloated.add(index.name)

      if (this.#warnedBloat.has(index.name)) continue

      const reason = failed.get(index.name) ??
        (!rebuilding
          ? (this.#reindexUnavailable ?? 'automatic reindexing is disabled')
          : !index.owned
              ? 'the connected role does not own the index'
              : 'the index is larger than maxIndexBytes')

      await emitAndPersistWarning(this.#warningContext,
        WARNING_TYPES.INDEX_BLOAT,
        `Warning: index "${index.name}" is bloated (${Math.round(Number(index.bytes) / 1024 / 1024)} MB across ${index.pages} pages for ~${index.entries} live entries) and was not rebuilt: ${reason}. See getReindexCommands()`,
        index
      )
    }

    this.#warnedBloat = stillBloated
  }

  /**
   * The REINDEX statements this instance would run, for installations where it cannot run them
   * itself. Unlike the background pass this applies no ownership filter and no size cap unless one
   * is passed — the commands are for an operator, who may run them as a different role.
   */
  async getReindexCommands (options?: types.ReindexOptions): Promise<string[]> {
    const schema = this.#config.schema

    const sql = options?.force
      ? plans.getJobIndexes(schema)
      : plans.getBloatedIndexes(schema, undefined, options)

    const { rows } = await this.#executeQuery(sql)

    const targets = options?.maxIndexBytes === undefined
      ? rows
      : rows.filter((i: types.IndexBloat) => Number(i.bytes) <= options.maxIndexBytes!)

    if (!targets.length) return []

    const { rows: leftovers } = await this.#executeQuery(plans.getReindexLeftovers(schema))
    const commands: string[] = []

    for (const target of targets) {
      // Postgres names the transient index `<index>_ccnew`, then `_ccnew1`, `_ccnew2` on collision.
      for (const leftover of leftovers) {
        if (leftover.name.startsWith(`${target.name}_ccnew`)) {
          commands.push(plans.dropIndexConcurrently(schema, leftover.name))
        }
      }

      commands.push(plans.reindexIndex(schema, target.name))
    }

    return commands
  }
}

export default Boss
