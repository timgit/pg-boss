import EventEmitter from 'node:events'
import pg from 'pg'
import assert from 'node:assert'
import type * as types from './types.ts'

class Db extends EventEmitter implements types.IDatabase, types.EventsMixin {
  private pool!: pg.Pool
  private config: types.DatabaseOptions
  /** @internal */
  readonly _pgbdb: true
  opened: boolean

  constructor (config: types.DatabaseOptions) {
    super()

    config.application_name = config.application_name || 'pgboss'
    // config.maxUses = config.maxUses || 1000

    this.config = config
    this._pgbdb = true
    this.opened = false
  }

  events = {
    error: 'error'
  }

  async open () {
    this.pool = new pg.Pool(this.config)
    this.pool.on('error', error => this.emit('error', error))
    this.opened = true
  }

  async close () {
    if (!this.pool.ending) {
      this.opened = false
      await this.pool.end()
    }
  }

  async executeSql (text: string, values?: unknown[]) {
    assert(this.opened, 'Database not opened. Call open() before executing SQL.')

    // if (this.config.debug === true) {
    //   console.log(`${new Date().toISOString()}: DEBUG SQL`)
    //   console.log(text)

    //   if (values) {
    //     console.log(`${new Date().toISOString()}: DEBUG VALUES`)
    //     console.log(values)
    //   }
    // }

    return await this.pool.query(text, values)
  }
}

export default Db
