import EventEmitter from 'node:events'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import type * as types from './types.ts'

const events = {
  error: 'error',
  warning: 'warning'
}

const WARNING_TYPE = 'listen_notify_unavailable'

// Owns the LISTEN/NOTIFY listener lifecycle. A NOTIFY is only ever a latency hint: it
// wakes workers so they run their normal locking fetch sooner than the polling interval
// If the listener can't be established (custom adapter, PgBouncer transaction pooling,
// dropped connection), fall back to polling after emitting a warning.
class Notifier extends EventEmitter implements types.EventsMixin {
  events = events
  #db: types.IDatabase
  #manager: Manager
  #config: types.ResolvedConstructorOptions
  #handle: types.ListenHandle | null = null
  #stopped = true

  constructor (db: types.IDatabase, manager: Manager, config: types.ResolvedConstructorOptions) {
    super()
    this.#db = db
    this.#manager = manager
    this.#config = config
  }

  // True only once the listener handle is established. False before start(), when the
  // database doesn't support LISTEN or it fails (warning path), and after stop(). Workers
  // read this to decide between the relaxed notify polling interval and the fallback.
  get available (): boolean {
    return this.#handle !== null
  }

  async start () {
    if (!this.#stopped) return
    this.#stopped = false

    // Some backends (e.g. CockroachDB) don't implement LISTEN/NOTIFY at all. Skip the
    // listener there even when useListenNotify was requested; polling still runs.
    if (this.#config.noListenNotify) {
      this.emit(events.warning, {
        message: `useListenNotify is not supported on the ${this.#config.backend} backend. Continuing with polling only.`,
        data: { type: WARNING_TYPE, backend: this.#config.backend }
      })
      return
    }

    if (typeof this.#db.listen !== 'function') {
      this.emit(events.warning, {
        message: 'useListenNotify is enabled but the database connection does not support LISTEN/NOTIFY. Continuing with polling only.',
        data: { type: WARNING_TYPE }
      })
      return
    }

    try {
      // Resolve the channel literal once from the shared SQL expression. LISTEN cannot take
      // an expression, so the listener needs the concrete name; the producer inlines the
      // same expression, so both sides always agree.
      const { rows } = await this.#db.executeSql(`SELECT ${plans.notifyChannelSql(this.#config.schema)} AS channel`)
      const channel = rows[0].channel

      this.#handle = await this.#db.listen(
        channel,
        payload => this.#manager.notifyQueue(payload),
        () => this.#manager.forceFetchLnWorkers()
      )
    } catch (err: any) {
      this.emit(events.warning, {
        message: 'Failed to start LISTEN/NOTIFY listener. Continuing with polling only.',
        data: { type: WARNING_TYPE, error: err?.message }
      })
    }
  }

  async stop () {
    if (this.#stopped) return
    this.#stopped = true

    if (this.#handle) {
      try {
        await this.#handle.close()
      } catch (err) {
        this.emit(events.error, err)
      }
      this.#handle = null
    }
  }
}

export default Notifier
