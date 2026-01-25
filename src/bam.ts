import EventEmitter from 'node:events'
import * as plans from './plans.js'
import * as types from './types.js'

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
  }

  async #onPoll () {
    if (this.#stopped || this.#working || !this.#config.migrate) return

    this.#working = true

    try {
      if (this.#config.__test__throw_bam) {
        throw new Error(this.#config.__test__throw_bam)
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
      table: entry.table
    })

    try {
      await this.#db.executeSql(entry.command)

      if (this.#stopped) return

      await this.#markCompleted(entry.id)

      this.emit(events.bam, {
        id: entry.id,
        name: entry.name,
        status: 'completed',
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
        table: entry.table,
        error: String(err)
      })
    }
  }

  async #getNextCommand (): Promise<types.BamEntry | null> {
    const sql = plans.getNextBamCommand(this.#config.schema)
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
