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
  LARGE_QUEUE: { size: 10_000, message: 'Warning: large queue backlog. Your queue should be reviewed' },
  // No threshold constant: the trigger is measured, not configured. See #checkVacuum.
  XMIN_HORIZON: { message: 'Warning: the database transaction horizon is pinned, so completed jobs cannot be cleaned up' },
  AUTOVACUUM_DISABLED: { message: 'Warning: autovacuum is disabled, so nothing is reclaiming completed jobs' },
  // Deliberately weaker than XMIN_HORIZON, and the difference is the evidence behind each. That one
  // asserts the horizon is pinned and that jobs cannot be reclaimed, having watched a vacuum run and
  // reclaim nothing across two passes. This one has a stopwatch and nothing else. The aggregate does
  // pin the horizon while it runs - that much is definitional - but whether any reclamation was
  // actually lost to it is not measured here, so this reports the exposure and the action taken and
  // leaves the diagnosis to XMIN_HORIZON, which will fire on its own if the harm is real.
  MONITOR_BACKOFF: { message: 'Warning: queue monitoring spent long enough scanning the job table to risk holding back autovacuum, so the next stats refresh is deferred' }
}

const WARNING_TYPES = {
  SLOW_QUERY: 'slow_query',
  QUEUE_BACKLOG: 'queue_backlog',
  INDEX_BLOAT: 'index_bloat',
  XMIN_HORIZON: 'xmin_horizon',
  AUTOVACUUM_DISABLED: 'autovacuum_disabled',
  MONITOR_BACKOFF: 'monitor_backoff'
} as const

// Which holder class each source in the horizon query represents, phrased so the warning names
// something an operator can go and look at.
const XMIN_HOLDERS: Record<plans.XminHorizonSource, string> = {
  backends: 'a backend holding an open transaction',
  slots: 'a replication slot',
  slotsCatalog: 'a replication slot (catalog xmin)',
  standbys: 'a standby with hot_standby_feedback enabled',
  prepared: 'a prepared transaction'
}

// The oldest backend holding the horizon, as far as this role is allowed to see it. state is null
// for a backend owned by another role; pid, applicationName and userName always survive. The query
// text is deliberately absent - see getXminHorizon for why collecting it, at any length, is not
// something a persisted and log-forwarded warning should do.
type XminBackendHolder = {
  pid: number
  applicationName: string | null
  userName: string | null
  state: string | null
  age: number | null
  xactSeconds: number | null
}

type XminHorizonRow = Partial<Record<plans.XminHorizonSource, number | null>> & {
  oldestTransactionSeconds?: number | null
  backendHolder?: XminBackendHolder | null
  opaqueBackends?: number | null
  selfApplicationName?: string | null
}

// Name the holder as specifically as the catalog allowed. Falls back to the holder class when the
// source is not a backend (a replication slot has no pid to report) or when no backend row came
// back, so the warning never loses the description it had before.
function describeXminHolder (source: plans.XminHorizonSource, row: XminHorizonRow): string {
  const holder = source === 'backends' ? row.backendHolder : null

  if (!holder) return XMIN_HOLDERS[source]

  const app = holder.applicationName || null

  const where = [
    app && `application_name '${app}'`,
    holder.userName && `role ${holder.userName}`,
    `pid ${holder.pid}`
  ].filter(Boolean).join(', ')

  const open = holder.xactSeconds === null || holder.xactSeconds === undefined
    ? 'for an unreadable length of time'
    : `for ${holder.xactSeconds}s`

  // Three outcomes, not two, because an empty application_name cannot be classified either way and
  // saying "another application" would be asserting something unmeasured. Comparison is against
  // this connection's own value rather than the literal 'pgboss': an adapter-supplied pool carries
  // whatever the host app set, so "same application_name as us" is the strongest true claim.
  const who = !app
    ? 'a backend with no application_name'
    : app === row.selfApplicationName
      ? "this application's own connection"
      : 'another application'

  return `${who} (${where}) has held a transaction open ${open}`
}

// One job table's garbage, as two consecutive supervise passes saw it.
interface TableGarbage {
  name: string
  liveTuples: number
  deadTuples: number
  budget: number
  vacuumAgeSeconds: number | null
  lastVacuum: number
}

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
  // Local rate limit for passes that only report bloat, which deliberately leave the shared interval
  // claim to whichever instance can act on it.
  #detectOnly = 0
  // Latched while a job table is over its autovacuum budget, so a sustained pin warns once rather
  // than every pass. Cleared when every table is back under budget, so a later episode warns again.
  #warnedXminHorizon = false
  // Same latching for the sibling diagnosis: garbage growing on a table nothing vacuums at all.
  #warnedAutovacuumDisabled = false
  // Per job table: the dead-tuple count and vacuum timestamp last seen while the table was over its
  // autovacuum budget. Two observations are what turn "there is garbage" into "a vacuum ran and
  // reclaimed none of it" - see #checkXminHorizon.
  #garbageEvidence = new Map<string, { deadTuples: number, lastVacuum: number }>()
  // Sources the connected role could not read. Narrowed once on first failure rather than retried
  // every pass; an empty-but-unreadable source must never be reported as healthy.
  #xminHorizonSources: plans.XminHorizonSource[] | null = null
  // Seconds this supervise pass held the MVCC horizon inside the queue-stats aggregate, as the
  // server measured it, summed across every table and every 100-name chunk. The sum, not the worst
  // single query: chunking and partitioned queues both multiply the aggregate within one pass (each
  // chunk re-reads the whole heap - measured at 384,632 buffers for 2 of 20 queue names), and it is
  // the total contiguous pin that starves autovacuum, not any one scan.
  #statsElapsedSeconds = 0

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

    // Immediately after the aggregates it measures, not at the head of the next pass. Deferring the
    // write left a whole supervise interval between a slow aggregate finishing and the gate closing
    // behind it, and a getQueueStats({ force: true }) landing in that window ran exactly the scan
    // the backoff was about to prevent.
    await this.#applyMonitorBackoff()

    await this.#checkVacuum()

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
      // The vacuum-safety backoff defers the stats aggregate, not the whole pass. Job expiry and
      // heartbeat failure below are narrow indexed updates that pin nothing, and gating them on the
      // horizon would turn a vacuum-safety valve into a job-expiry outage lasting two naptimes at
      // minimum. See the note on plans.trySetQueueMonitorTime. The flag is a property of the
      // statement, not of a queue, so every row carries the same value.
      const refreshStats = rows[0].refreshStats !== false

      if (refreshStats) {
        const cacheStatsSql = plans.cacheQueueStats(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
        // The pin this pass cost, taken from the server's own clock (see the pinSeconds column in
        // cacheQueueStats) and not from a stopwatch around the call - that would count pool wait,
        // network and event-loop lag, none of which hold the horizon. The client measurement stays as
        // a fallback for a backend or adapter that returns no rows to read it from.
        const statsStarted = Date.now()
        const { rows: rowsCacheStats } = await this.#executeQuery(cacheStatsSql)
        const pinned = rowsCacheStats.reduce((max, row) => Math.max(max, Number(row.pinSeconds) || 0), 0)

        // Only when the aggregate actually ran. An empty result means another instance holds the
        // stats try-lock and this statement returned without scanning anything, so the elapsed
        // client time is pool and network latency - exactly the measurement the server-side
        // pinSeconds column exists to avoid backing off on.
        if (rowsCacheStats.length) {
          this.#statsElapsedSeconds += pinned || (Date.now() - statsStarted) / 1000
        }

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
      }

      if (this.#stopping) return

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

  /**
   * Defer the next queue-stats aggregate when this pass spent long enough inside it to threaten
   * autovacuum, and tell the operator that it happened.
   *
   * The aggregate in cacheQueueStats is a whole-heap scan - the queue-name filter does not reduce
   * the I/O, only the number of rows fed to the aggregate transitions - and for its whole duration
   * it advertises a snapshot Postgres will not vacuum past. Measured on a 3 GB / 10M-row job table:
   * 0.19 s at 1M rows, 2.1 s with parallel workers and 3.6 s without at 10M, and 24-75 s for the
   * same 3 GB read cold from network storage. Against that, a 200,000-row delete stayed
   * "dead but not yet removable" for exactly as long as one such snapshot was held open, and was
   * removed by the next vacuum after it closed.
   *
   * What is measured is the server's own transaction duration, not the latency of the call: a pool
   * with no free connection makes executeSql slow without pinning anything (a 1 ms transaction timed
   * at 1.97 s behind one busy connection), and backing off on that would defer monitoring for pool
   * contention and then tell the operator to go and shrink their job table.
   *
   * So the danger is not the aggregate; it is the aggregate's duty cycle. Three things push it up
   * without anyone changing a default - a slow enough scan that a pass outruns the interval, the
   * 100-name chunking that makes one pass re-read the heap once per chunk, and one aggregate per
   * table on a partitioned deployment - and one thing pushes it up deliberately, which is tuning
   * monitorIntervalSeconds down. All four land in the same place, and #statsElapsedSeconds measures
   * all four the same way.
   *
   * The threshold and the length both come from the server's own autovacuum_naptime rather than
   * from a constant here; see plans.setMonitorBackoff for why the free window has to be longer than
   * a naptime and why two of them is the right number. The statement returns a row only when it
   * engaged, so this warns exactly when monitoring is actually being held back.
   *
   * PostgreSQL-only, and off with the rest of the vacuum subsystem: distributed backends have no
   * autovacuum_naptime to read and reclaim on their own schedule, and an operator who set
   * monitorVacuum: false has taken vacuum health into their own hands.
   */
  async #applyMonitorBackoff () {
    const elapsed = this.#config.__test__monitor_stats_seconds ?? this.#statsElapsedSeconds
    this.#statsElapsedSeconds = 0

    if (!elapsed) return
    if (this.#config.monitorVacuum === false || this.#config.noMonitorVacuum) return

    const { rows } = await this.#executeQuery(plans.setMonitorBackoff(this.#config.schema, elapsed))

    const engaged = rows.at(0)

    if (!engaged) return

    await emitAndPersistWarning(this.#warningContext,
      WARNING_TYPES.MONITOR_BACKOFF,
      `${WARNINGS.MONITOR_BACKOFF.message}: ${elapsed.toFixed(1)}s of aggregate against an ` +
      `autovacuum_naptime of ${Number(engaged.naptimeSeconds)}s. ` +
      'Shrink the job table (retention, deleteAfterSeconds) or partition its busiest queues.',
      {
        elapsedSeconds: elapsed,
        naptimeSeconds: Number(engaged.naptimeSeconds),
        backoffSeconds: Number(engaged.backoffSeconds),
        backoffUntil: engaged.backoffUntil
      }
    )
  }

  /**
   * Warn when the queues are producing garbage that nothing is reclaiming. Every documented
   * Postgres-queue collapse has this as its precondition, and until now pg-boss reported only the
   * symptom (`queue_backlog`) and never the cause: a backlog caused by too few workers and one
   * caused by unreclaimed garbage look identical from the queue's own counters, and have opposite
   * fixes.
   *
   * One measurement, two diagnoses, because the fixes are completely different:
   *
   *   `xmin_horizon`        vacuum runs and reclaims nothing - something is pinning the MVCC
   *                         horizon, and the fix is to find and release the holder.
   *   `autovacuum_disabled` nothing runs at all - autovacuum is turned off on the table, and the
   *                         fix is to turn it back on or vacuum on a schedule that keeps up.
   *
   * The trigger is the harm itself, read from `pg_stat_user_tables`, not a transaction-count proxy.
   * A measured comparison of the two (scripts/xmin-horizon-experiment.js) is what settled this: the
   * transaction count that corresponds to a given amount of unreclaimable garbage moves by ~9x with
   * producer batching alone, and without bound with unrelated traffic on the same cluster, because
   * `age()` is cluster-global. No constant survives that. Dead tuples do not move: the same 40,000
   * jobs left the same 120,000 unreclaimable rows across both producer shapes.
   *
   * Both diagnoses share the first condition - a job table past the point Postgres itself would
   * vacuum it (`autovacuum_vacuum_threshold + scale_factor * live`, per-table storage parameters
   * honoured) - and then split on what two consecutive observations show:
   *
   *   a vacuum ran and the dead-tuple count did not fall  -> the horizon is pinned
   *   no vacuum ran and the dead-tuple count grew         -> nothing is vacuuming this table
   *
   * Either way it takes two passes to establish, so the first pass after a problem starts never
   * warns. That is the intended cost of not guessing: one supervise interval of delay buys a signal
   * that means what it says. It is also what keeps an operator who has turned autovacuum off
   * deliberately and vacuums on their own schedule quiet - their manual vacuum both moves the
   * timestamp and drops the count, so neither branch matches.
   *
   * PostgreSQL-only: CockroachDB and YugabyteDB reclaim on their engine's own schedule rather than
   * from the oldest live snapshot, and their profiles set noMonitorVacuum.
   */
  async #checkVacuum () {
    if (this.#stopping) return

    if (this.#config.monitorVacuum === false || this.#config.noMonitorVacuum) return

    const { rows } = await this.#executeQuery(plans.getJobTableGarbage(this.#config.schema))

    if (this.#stopping) return

    // Vacuum ran and reclaimed nothing, versus nothing ran at all.
    const stuck: TableGarbage[] = []
    const unvacuumed: TableGarbage[] = []
    // Tracked separately so one table sitting permanently over budget with autovacuum off cannot
    // pin the other diagnosis's latch and suppress a later, unrelated episode.
    let vacuumedOverBudget = false
    let disabledOverBudget = false

    // Partitioned queues come and go, so drop evidence for tables the query no longer returns
    // rather than holding a row per table this instance has ever seen.
    const present = new Set(rows.map(row => row.name as string))

    for (const name of this.#garbageEvidence.keys()) {
      if (!present.has(name)) this.#garbageEvidence.delete(name)
    }

    for (const row of rows) {
      const name = row.name as string
      const liveTuples = Number(row.liveTuples)
      const deadTuples = Number(row.deadTuples)
      const budget = Number(row.threshold) + Number(row.scaleFactor) * liveTuples
      const disabled = row.autovacuumEnabled === false
      // Compared only against the previous observation of the same table, so any monotonic clock
      // works; a table never vacuumed reads as 0 and stays there, which is exactly the state the
      // autovacuum_disabled branch is looking for.
      const lastVacuum = row.lastVacuum ? new Date(row.lastVacuum).getTime() : 0

      if (deadTuples <= budget) {
        this.#garbageEvidence.delete(name)
        continue
      }

      if (disabled) {
        disabledOverBudget = true
      } else {
        vacuumedOverBudget = true
      }

      const previous = this.#garbageEvidence.get(name)
      this.#garbageEvidence.set(name, { deadTuples, lastVacuum })

      if (!previous) continue

      const garbage = {
        name,
        liveTuples,
        deadTuples,
        budget,
        // Null rather than 0 when the table has never been vacuumed at all - "never" and "just now"
        // are opposite readings and must not share a value.
        vacuumAgeSeconds: row.vacuumAgeSeconds === null ? null : Number(row.vacuumAgeSeconds),
        lastVacuum
      }

      if (disabled) {
        // Nothing ran between the two observations and the pile grew.
        if (lastVacuum === previous.lastVacuum && deadTuples > previous.deadTuples) {
          unvacuumed.push(garbage)
        }
      } else if (lastVacuum > previous.lastVacuum && deadTuples >= previous.deadTuples) {
        // A vacuum ran between the two observations and left at least as much garbage as it found.
        stuck.push(garbage)
      }
    }

    if (!vacuumedOverBudget) this.#warnedXminHorizon = false
    if (!disabledOverBudget) this.#warnedAutovacuumDisabled = false

    await this.#warnAutovacuumDisabled(unvacuumed)
    await this.#warnXminHorizon(stuck)
  }

  /**
   * Garbage piling up on a table nothing vacuums. No horizon lookup: there is no vacuum here that
   * could have failed, so there is no holder to blame, and naming one would send the operator after
   * the wrong thing entirely. The fix is autovacuum, not a stuck transaction.
   */
  async #warnAutovacuumDisabled (unvacuumed: TableGarbage[]) {
    if (!unvacuumed.length || this.#warnedAutovacuumDisabled || this.#stopping) return

    this.#warnedAutovacuumDisabled = true

    const worst = unvacuumed.reduce((a, b) => (b.deadTuples > a.deadTuples ? b : a))
    const since = worst.vacuumAgeSeconds === null
      ? 'has never been vacuumed'
      : `was last vacuumed ${worst.vacuumAgeSeconds}s ago`

    await emitAndPersistWarning(this.#warningContext,
      WARNING_TYPES.AUTOVACUUM_DISABLED,
      `${WARNINGS.AUTOVACUUM_DISABLED.message}: ${worst.name} has autovacuum_enabled = false, holds ` +
      `${worst.deadTuples} dead rows and is still growing, and ${since} ` +
      `(Postgres would vacuum this table at ${Math.round(worst.budget)})`,
      {
        table: worst.name,
        tables: unvacuumed.map(t => t.name),
        liveTuples: worst.liveTuples,
        deadTuples: worst.deadTuples,
        budget: Math.round(worst.budget),
        vacuumAgeSeconds: worst.vacuumAgeSeconds
      }
    )
  }

  /** Garbage that survived a vacuum, attributed to whatever is holding the horizon back. */
  async #warnXminHorizon (stuck: TableGarbage[]) {
    if (!stuck.length || this.#warnedXminHorizon || this.#stopping) return

    // The vacuum a holder has to predate is the most recent one that failed, so the newest wins.
    const lastVacuum = new Date(Math.max(...stuck.map(t => t.lastVacuum)))
    const horizon = await this.#readXminHorizon(lastVacuum)

    if (!horizon || this.#stopping) return

    const holder = this.#attributeXminHorizon(horizon.row)

    // Garbage that survived a vacuum with no holder old enough to explain it is a real problem, but
    // not this one - staying quiet is what keeps the warning worth acting on.
    if (!holder) return

    this.#warnedXminHorizon = true

    const worst = stuck.reduce((a, b) => (b.deadTuples > a.deadTuples ? b : a))
    const seconds = Number(horizon.row.oldestTransactionSeconds)

    const backend = holder.source === 'backends' ? horizon.row.backendHolder ?? null : null
    const opaque = Number(horizon.row.opaqueBackends) || 0

    // Only worth saying when the holder could not be named: with a name in hand the operator has
    // what they need, and the grant is beside the point.
    const opaqueNote = opaque && !backend
      ? ` ${opaque} backend(s) could not be inspected by this role; GRANT pg_read_all_stats to name them.`
      : ''

    await emitAndPersistWarning(this.#warningContext,
      WARNING_TYPES.XMIN_HORIZON,
      `${WARNINGS.XMIN_HORIZON.message}: ${describeXminHolder(holder.source, horizon.row)}, ` +
      `holding it ${holder.age} transactions back. ` +
      `${worst.name} has ${worst.deadTuples} dead rows that a vacuum ${worst.vacuumAgeSeconds}s ago could not reclaim ` +
      `(Postgres vacuums this table at ${Math.round(worst.budget)}).${opaqueNote}`,
      {
        source: holder.source,
        holder: describeXminHolder(holder.source, horizon.row),
        holderClass: XMIN_HOLDERS[holder.source],
        // Null unless the holder is a backend this role could read a row for. `self` says whether it
        // shares this connection's application_name — pg-boss pinning its own horizon and an
        // external reporting tool pinning it have opposite fixes.
        holderPid: backend?.pid ?? null,
        holderApplicationName: backend?.applicationName ?? null,
        holderUserName: backend?.userName ?? null,
        holderState: backend?.state ?? null,
        holderTransactionSeconds: backend?.xactSeconds ?? null,
        self: backend ? backend.applicationName === horizon.row.selfApplicationName : null,
        // Backends whose transaction this role is not allowed to time. Non-zero means the picture is
        // partial, whether or not a holder was named.
        opaqueBackends: opaque,
        transactions: holder.age,
        table: worst.name,
        liveTuples: worst.liveTuples,
        deadTuples: worst.deadTuples,
        budget: Math.round(worst.budget),
        vacuumAgeSeconds: worst.vacuumAgeSeconds,
        tables: stuck.map(t => t.name),
        oldestTransactionSeconds: Number.isFinite(seconds) ? seconds : null,
        // Named so a partial answer is never mistaken for a clean one.
        unreadableSources: horizon.unreadable
      }
    )
  }

  /**
   * The widest holder in the row. Every source the query returns has already been qualified — the
   * backends column is filtered server-side to transactions that predate the failed vacuum, and a
   * slot, standby or prepared transaction advertises an xmin only while something is genuinely
   * stuck — so this is a straight maximum. The horizon is pinned to the oldest of them, which makes
   * the widest the one worth naming.
   */
  #attributeXminHorizon (row: XminHorizonRow) {
    let worst: { source: plans.XminHorizonSource, age: number } | null = null

    // Iterates the known holder classes, not the row's columns: the row also carries
    // oldestTransactionSeconds, which is informational and would otherwise read as a holder named
    // after a column with an age of 0.
    for (const source of Object.keys(XMIN_HOLDERS) as plans.XminHorizonSource[]) {
      const value = row[source]
      const age = value === undefined || value === null ? NaN : Number(value)

      if (Number.isFinite(age) && (!worst || age > worst.age)) {
        worst = { source, age }
      }
    }

    return worst
  }

  /**
   * Read the horizon, narrowing to the sources this role can actually read. Called only when a
   * table already shows unreclaimable garbage, so an installation with a healthy horizon never
   * pays for it.
   */
  async #readXminHorizon (lastVacuum: Date) {
    const attempted = this.#xminHorizonSources ?? plans.XMIN_HORIZON_QUERY_SOURCES

    // Narrowing has already found that this role can read none of them, and the check said so once.
    // Without this the empty list would be handed back to getXminHorizon, which cannot build a
    // statement with no columns, and every later pass would re-fail, re-probe and re-warn.
    if (!attempted.length) return null

    try {
      const { rows } = await this.#executeQuery(plans.getXminHorizon(lastVacuum, attempted))
      const unreadable = plans.XMIN_HORIZON_QUERY_SOURCES.filter(name => !attempted.includes(name))

      return { row: (rows[0] ?? {}) as XminHorizonRow, unreadable }
    } catch (err) {
      // A role that cannot read one of the catalogs fails the whole statement. Narrow to the
      // sources that do work rather than losing the check entirely - but remember what was dropped,
      // because "no rows" from an unreadable view must not read as "horizon is healthy".
      const readable = await this.#narrowXminHorizonSources(attempted, lastVacuum)

      this.#xminHorizonSources = readable

      if (!readable.length) {
        this.emit(events.warning, {
          message: 'Unable to read the transaction horizon; the xmin_horizon check is disabled for this instance.',
          data: { type: WARNING_TYPES.XMIN_HORIZON, error: (err as Error)?.message }
        })
      }

      return null
    }
  }

  // Probe each source alone to find which ones this role can actually read. Runs only after the
  // combined query has already failed, so the cost is paid once per instance, not per pass.
  async #narrowXminHorizonSources (attempted: readonly plans.XminHorizonSource[], lastVacuum: Date) {
    const readable: plans.XminHorizonSource[] = []

    for (const source of attempted) {
      try {
        await this.#executeQuery(plans.getXminHorizon(lastVacuum, [source]))
        readable.push(source)
      } catch {
        // Unreadable for this role; reported alongside the warning as unreadableSources.
      }
    }

    return readable
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
    const rebuilding = resolved !== null && !this.#reindexUnavailable

    // An explicit force is a request to run now; everything else waits for an interval.
    //
    // Which interval depends on whether this instance can do the work. The shared claim exists so
    // exactly one instance in the cluster rebuilds per window — an instance that is only ever going
    // to report bloat has no business taking it, or a peer configured to rebuild would find the
    // window gone and skip the rebuild for a whole day. Detection-only passes throttle themselves
    // locally instead, on the same interval.
    if (!force) {
      if (rebuilding) {
        const claim = plans.trySetReindexTime(this.#config.schema, this.#config.reindexIntervalSeconds)
        const { rows } = await this.#executeQuery(claim)
        if (!rows.length) return
      } else {
        if (Date.now() < this.#detectOnly) return
        this.#detectOnly = Date.now() + this.#config.reindexIntervalSeconds * 1000
      }
    }

    if (this.#stopping) return

    const scope = tables.length ? tables : undefined
    const detectSql = plans.getBloatedIndexes(this.#config.schema, scope, resolved ?? undefined)
    const { rows: bloated } = await this.#executeQuery(detectSql)

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
      const { rows } = await this.#executeQuery(plans.getReindexLeftovers(this.#config.schema, tables, this.#config.noIndexProgressView))

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

      // Ownership first: an index the role cannot touch was never a candidate, so it has no entry in
      // `failed` no matter why the pass stopped. #reindexUnavailable comes next and covers the
      // indexes the 25001 giveup skipped without attempting — they are neither failed nor rebuilt,
      // and reporting a size cap they are nowhere near would point at the wrong knob.
      const reason = failed.get(index.name) ??
        (!index.owned
          ? 'the connected role does not own the index'
          : this.#reindexUnavailable ??
            (!rebuilding
              ? 'automatic reindexing is disabled'
              : 'the index is larger than maxIndexBytes'))

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
    // The catalog query reads pg_class.relpages and pg_relation_size(), which the heap-less engines
    // either reject outright or answer with zeroes — same gate as #reindex, and there is nothing to
    // rebuild on them anyway.
    if (this.#config.noReindex) return []

    const schema = this.#config.schema

    const sql = options?.force
      ? plans.getJobIndexes(schema)
      : plans.getBloatedIndexes(schema, undefined, options)

    const { rows } = await this.#executeQuery(sql)

    const targets = options?.maxIndexBytes === undefined
      ? rows
      : rows.filter((i: types.IndexBloat) => Number(i.bytes) <= options.maxIndexBytes!)

    if (!targets.length) return []

    const { rows: leftovers } = await this.#executeQuery(plans.getReindexLeftovers(schema, undefined, this.#config.noIndexProgressView, true))

    return plans.buildReindexCommands(schema, targets, leftovers)
  }
}

export default Boss
