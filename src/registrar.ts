import EventEmitter from 'node:events'
import os from 'node:os'
import packageJson from '../package.json' with { type: 'json' }
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import * as types from './types.ts'

const events = {
  error: 'error'
}

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

  events = events

  constructor (id: string, db: types.IDatabase, manager: Manager, config: types.ResolvedConstructorOptions) {
    super()

    this.id = id
    this.#db = db
    this.#manager = manager
    this.#config = config
  }

  async start () {
    if (!this.#config.registerInstance || this.#timer) return

    try {
      const { rows } = await this.#db.executeSql(plans.registerInstance(this.#config.schema), this.#values())
      this.#startedOn = rows[0]?.startedOn ?? null
    } catch (err) {
      this.emit(events.error, err)
    }

    this.#timer = this.#config.clock.setInterval(() => { this.#beat() }, this.#config.instanceHeartbeatSeconds! * 1000)
  }

  async stop () {
    if (!this.#timer) return

    this.#config.clock.clearInterval(this.#timer)
    this.#timer = undefined

    await this.#beating

    // Best effort and silent: a stop that cannot reach the database leaves a row that goes quiet
    // after three missed heartbeats, which is the same ending a crash gets, and a host that closed
    // its own adapter before stopping pg-boss should not hear about it.
    try {
      await this.#db.executeSql(plans.stopInstance(this.#config.schema), [this.id])
    } catch {}
  }

  async getInstances (): Promise<types.Instance[]> {
    const { rows } = await this.#db.executeSql(plans.getInstances(this.#config.schema))

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
      workers: typeof row.workers === 'string' ? JSON.parse(row.workers) : row.workers
    }))
  }

  #beat () {
    // One beat at a time: a slow one is not stacked on, the next tick simply finds it running.
    if (this.#beating) return

    this.#beating = (async () => {
      try {
        await this.#db.executeSql(plans.heartbeatInstance(this.#config.schema), [...this.#values(), this.#startedOn])
      } catch (err) {
        this.emit(events.error, err)
      } finally {
        this.#beating = null
      }
    })()
  }

  // In the column order of plans.registerInstance.
  #values (): unknown[] {
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
      JSON.stringify(this.#workers())
    ]
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
          lastErrorOn: null
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
