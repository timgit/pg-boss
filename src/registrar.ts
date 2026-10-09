import EventEmitter from 'node:events'
import os from 'node:os'
import packageJson from '../package.json' with { type: 'json' }
import Nurse from './nurse.ts'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import * as types from './types.ts'

const events = {
  error: 'error'
}

// The constructor options recorded in the registry, so instances sharing a database can be compared.
// An allowlist on purpose: the table is readable by anything that can read the schema, and an option
// added later that carries a credential, a connection string or an object must not land in it by
// default. The adapter itself is recorded only as whether one was given.
const RECORDED_OPTIONS = [
  'backend', 'max', 'useListenNotify', 'instanceHeartbeatSeconds',
  'supervise', 'schedule', 'migrate', 'createSchema',
  'superviseIntervalSeconds', 'maintenanceIntervalSeconds', 'monitorIntervalSeconds', 'queueCacheIntervalSeconds',
  'bamIntervalSeconds', 'flowIntervalSeconds', 'reindex', 'reindexIntervalSeconds', 'monitorVacuum',
  'clockMonitorIntervalSeconds', 'cronMonitorIntervalSeconds', 'cronWorkerIntervalSeconds',
  'persistWarnings', 'warningRetentionDays', 'persistQueueStats', 'queueStatRetentionDays',
  'warningSlowQuerySeconds', 'warningQueueSize'
] as const satisfies ReadonlyArray<keyof types.ResolvedConstructorOptions>

// The work() options recorded on each worker entry, besides the three it keeps as fields. The same
// allowlist reasoning: groupConcurrency tiers are names, never data, and nothing here connects.
const RECORDED_WORK_OPTIONS = [
  'includeMetadata', 'ignoreStartAfter', 'minPriority', 'maxPriority', 'localGroupConcurrency', 'groupConcurrency',
  'heartbeatRefreshSeconds', 'perJobResults', 'transactional', 'transactionTimeoutSeconds', 'notifyPollingIntervalSeconds',
  'burstWhenReadyExceeds', 'burstWhenBatchFull'
] as const satisfies ReadonlyArray<keyof types.WorkOptions>

// Keeps this PgBoss object's row in the instance table: registered at start(), refreshed on its own
// heartbeat timer whether or not this instance supervises (an instance with supervise off is exactly
// the kind people lose track of), and marked stopped by a graceful stop(). Nothing on the job path
// waits for it. A failed write is emitted as an error and the next beat tries again, and since a beat
// is an upsert, it also restores a row a failed registration or the retention prune left missing.
class Registrar extends EventEmitter implements types.EventsMixin {
  readonly id: string
  #db: types.IDatabase
  #manager: Manager
  #config: types.ResolvedConstructorOptions
  #timer: types.ClockTimer | undefined
  #beating: Promise<void> | null = null
  #startedOn: Date | null = null
  #nurse = new Nurse()
  #recount: types.ClockTimer | undefined
  #active = false
  #startAttempt = 1

  events = events

  constructor (id: string, db: types.IDatabase, manager: Manager, config: types.ResolvedConstructorOptions) {
    super()

    this.id = id
    this.#db = db
    this.#manager = manager
    this.#config = config
  }

  // startAttempt is the start() try this registration comes from, recorded in config when past the first.
  async start (startAttempt = 1) {
    if (!this.#config.registerInstance || this.#timer) return

    this.#startAttempt = startAttempt

    this.#active = true
    this.#nurse.start()

    try {
      const { rows } = await this.#db.executeSql(plans.registerInstance(this.#config.schema), await this.#values())
      this.#startedOn = rows[0]?.startedOn ?? null

      // Counted before the pruning, which keeps the earliest rows' counts only if they are already right.
      await this.#countCrashRestarts()

      // A crash-looping process registers once per life, so this is where its dead rows are bounded.
      await this.#db.executeSql(plans.pruneInstanceLives(this.#config.schema, plans.INSTANCE_DEAD_KEPT_PER_NAME),
        [this.id, this.#config.instanceName ?? null, os.hostname()])
    } catch (err) {
      this.emit(events.error, err)
    }

    this.#timer = this.#config.clock.setInterval(() => { this.#beat() }, this.#config.instanceHeartbeatSeconds! * 1000)
  }

  async stop () {
    if (!this.#timer) return

    this.#active = false
    this.#config.clock.clearInterval(this.#timer)
    this.#timer = undefined

    if (this.#recount !== undefined) {
      this.#config.clock.clearTimeout(this.#recount)
      this.#recount = undefined
    }

    await this.#beating
    this.#nurse.stop()

    // Best effort and silent: a stop that cannot reach the database leaves a row that goes quiet
    // after three missed heartbeats, which is the same ending a crash gets, and a host that closed
    // its own adapter before stopping pg-boss should not hear about it.
    try {
      await this.#db.executeSql(plans.stopInstance(this.#config.schema), [this.id])
    } catch {}
  }

  async getInstances (limit: number): Promise<types.Instance[]> {
    const { rows } = await this.#db.executeSql(plans.getInstances(this.#config.schema), [limit])

    // CockroachDB returns its INT8 columns as strings.
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

    return rows.map(row => ({
      ...row,
      pid: Number(row.pid),
      heartbeatSeconds: Number(row.heartbeatSeconds),
      poolMax: num(row.poolMax),
      poolTotal: num(row.poolTotal),
      poolIdle: num(row.poolIdle),
      poolWaiting: num(row.poolWaiting),
      workers: typeof row.workers === 'string' ? JSON.parse(row.workers) : row.workers,
      metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      crashRestarts: Number(row.crashRestarts)
    }))
  }

  // Counts this instance's crash restarts, and when a row on its name and host still reads live
  // without having beaten since this instance started, counts again once that row would go quiet.
  async #countCrashRestarts () {
    const clock = this.#config.clock
    const processStart = new Date(clock.now() - process.uptime() * 1000)
    const values = [this.id, this.#config.instanceName ?? null, os.hostname(), process.pid, processStart]

    await this.#db.executeSql(plans.countCrashRestarts(this.#config.schema), values)

    const { rows } = await this.#db.executeSql(plans.crashRecountAt(this.#config.schema), values)
    const at = rows[0]?.recountAt ? new Date(rows[0].recountAt).getTime() : null

    if (at === null || !this.#active) return

    this.#recount = clock.setTimeout(() => {
      this.#recount = undefined
      this.#countCrashRestarts().catch(err => this.emit(events.error, err))
    }, Math.max(1000, at - clock.now() + 1000))
  }

  #beat () {
    // One beat at a time: a slow one is not stacked on, the next tick simply finds it running.
    if (this.#beating) return

    this.#beating = (async () => {
      try {
        await this.#db.executeSql(plans.heartbeatInstance(this.#config.schema), [...await this.#values(), this.#startedOn])
      } catch (err) {
        this.emit(events.error, err)
      } finally {
        this.#beating = null
      }
    })()
  }

  // In the column order of plans.registerInstance.
  async #values (): Promise<unknown[]> {
    const config = this.#config
    const pool = typeof this.#db.poolCounts === 'function' ? this.#db.poolCounts() : null

    return [
      this.id,
      config.instanceName ?? null,
      os.hostname(),
      process.pid,
      packageJson.version,
      process.version,
      config.instanceHeartbeatSeconds,
      !!config.supervise,
      !!config.schedule,
      !!config.migrate,
      !!config.persistQueueStats,
      !!config.persistWarnings,
      pool?.max ?? null,
      pool?.total ?? null,
      pool?.idle ?? null,
      pool?.waiting ?? null,
      JSON.stringify(this.#workers()),
      JSON.stringify(await this.#nurse.check()),
      JSON.stringify(this.#recordedConfig())
    ]
  }

  // Options left unset are absent rather than null, so two instances on the same defaults compare equal.
  #recordedConfig (): Record<string, unknown> {
    const config: Record<string, unknown> = { adapter: this.#config.db ? 'custom' : 'pg' }

    for (const key of RECORDED_OPTIONS) {
      const value = this.#config[key]
      if (value !== undefined) config[key] = value
    }

    if (this.#startAttempt > 1) config.startAttempt = this.#startAttempt

    return config
  }

  // One entry per work() call. Each call spawns localConcurrency workers sharing a workId, so they are
  // folded back together here: jobs in hand summed, the latest times kept. Only lastErrorOn is
  // stored, never the error, since its message can carry job data and this table is readable by
  // anything that can read the schema.
  #workers (): types.InstanceWorker[] {
    const byWork = new Map<string, types.InstanceWorker>()
    const latest = (a: string | null, b: number | null) => {
      if (b === null) return a
      const iso = new Date(b).toISOString()
      return a === null || iso > a ? iso : a
    }

    for (const w of this.#manager.getWipData()) {
      let entry = byWork.get(w.workId)

      if (!entry) {
        entry = {
          id: w.workId,
          queue: w.name,
          localConcurrency: 0,
          batchSize: w.options.batchSize ?? 1,
          pollingIntervalSeconds: w.options.pollingIntervalSeconds ?? null,
          active: 0,
          lastFetchedOn: null,
          lastJobEndedOn: null,
          lastErrorOn: null,
          options: {}
        }
        for (const key of RECORDED_WORK_OPTIONS) {
          const value = w.options[key]
          if (value !== undefined) (entry.options as Record<string, unknown>)[key] = value
        }
        byWork.set(w.workId, entry)
      }

      entry.localConcurrency++
      entry.active += w.count
      entry.lastFetchedOn = latest(entry.lastFetchedOn, w.lastFetchedOn)
      entry.lastJobEndedOn = latest(entry.lastJobEndedOn, w.lastJobEndedOn)
      entry.lastErrorOn = latest(entry.lastErrorOn, w.lastErrorOn)
    }

    return [...byWork.values()]
  }
}

export default Registrar
