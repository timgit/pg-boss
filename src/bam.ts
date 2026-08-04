import EventEmitter from 'node:events'
import * as plans from './plans.ts'
import { delay } from './tools.ts'
import * as types from './types.ts'

const events = {
  error: 'error',
  bam: 'bam'
}

class Bam extends EventEmitter implements types.EventsMixin {
  #stopped: boolean
  #working: boolean
  #pollInterval: NodeJS.Timeout | undefined
  #db: types.IDatabase
  #config: types.ResolvedConstructorOptions

  events = events

  constructor (
    db: types.IDatabase,
    config: types.ResolvedConstructorOptions
  ) {
    super()

    this.#db = db
    this.#config = config
    this.#stopped = true
    this.#working = false
  }

  get working (): boolean {
    return this.#working
  }

  async start () {
    if (!this.#stopped) return
    this.#stopped = false

    setImmediate(() => this.#onPoll())
    this.#pollInterval = setInterval(
      () => this.#onPoll(),
      this.#config.bamIntervalSeconds * 1000
    )
  }

  async stop () {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#pollInterval) {
      clearInterval(this.#pollInterval)
      this.#pollInterval = undefined
    }
    while (this.#working) {
      await delay(10)
    }
  }

  async #onPoll () {
    if (this.#stopped || this.#working || !this.#config.migrate) return

    this.#working = true

    try {
      if (this.#config.__test__throw_bam) {
        throw new Error(this.#config.__test__throw_bam)
      }

      if (this.#config.__test__delay_bam_ms) {
        await delay(this.#config.__test__delay_bam_ms)
      }

      const sql = plans.trySetBamTime(
        this.#config.schema,
        this.#config.bamIntervalSeconds
      )
      const { rows } = await this.#db.executeSql(sql)

      if (rows.length === 1) {
        await this.#processCommands()
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.#working = false
    }
  }

  async #processCommands () {
    if (this.#stopped) return

    const entry = await this.#getNextCommand()
    if (!entry || this.#stopped) return

    this.emit(events.bam, {
      id: entry.id,
      name: entry.name,
      status: 'in_progress',
      queue: entry.queue,
      table: entry.table
    })

    try {
      // A re-attempted command (a stale in_progress reclaim, or a retry of a prior 'failed' — including
      // failed rows left by older releases) may have an INVALID index behind it from an interrupted or
      // failed CREATE INDEX CONCURRENTLY. Drop it first (best-effort, IF EXISTS) so the re-run rebuilds
      // cleanly instead of the command's own IF NOT EXISTS skipping over a broken index forever. Only on
      // the liveness path — CockroachDB/YugabyteDB roll interrupted builds back, so there's nothing to
      // heal and DROP ... CONCURRENTLY isn't their model.
      if (entry.reattempt && !this.#config.noIndexProgressView) {
        const dropSql = plans.bamHealDrop(this.#config.schema, entry.command)
        if (dropSql) {
          // Only heal an index the previous attempt left INVALID. A re-attempt can also fire for a
          // build that actually SUCCEEDED but whose row was never marked completed (a graceful stop
          // landed between the CREATE and markCompleted) — that index is VALID and in use, so dropping
          // it would tear down a live production index for the whole rebuild window. Probe indisvalid
          // first; skip the drop for a valid (or absent) index and let the command's IF NOT EXISTS re-run
          // no-op it and mark the row done.
          const probeSql = plans.bamHealProbe(this.#config.schema, entry.command)
          const { rows } = await this.#db.executeSql(probeSql!)
          if (rows[0]?.invalid) {
            await this.#db.executeSql(dropSql)
          }
        }
      }

      await this.#db.executeSql(entry.command)

      if (this.#stopped) return

      await this.#markCompleted(entry.id)

      this.emit(events.bam, {
        id: entry.id,
        name: entry.name,
        status: 'completed',
        queue: entry.queue,
        table: entry.table
      })
    } catch (err) {
      if (this.#stopped) return

      await this.#markFailed(entry.id, err)

      this.emit(events.error, err)

      this.emit(events.bam, {
        id: entry.id,
        name: entry.name,
        status: 'failed',
        queue: entry.queue,
        table: entry.table,
        error: String(err)
      })
    }
  }

  async #getNextCommand (): Promise<types.BamEntry | null> {
    const sql = plans.getNextBamCommand(this.#config.schema, { useLiveness: !this.#config.noIndexProgressView })
    const { rows } = await this.#db.executeSql(sql)
    return rows[0] || null
  }

  async #markCompleted (id: string): Promise<void> {
    const sql = plans.setBamCompleted(this.#config.schema, id)
    await this.#db.executeSql(sql)
  }

  async #markFailed (id: string, error: unknown): Promise<void> {
    const sql = plans.setBamFailed(this.#config.schema, id, String(error))
    await this.#db.executeSql(sql)
  }
}

export default Bam
