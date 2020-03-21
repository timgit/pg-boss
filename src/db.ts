import { EventEmitter } from 'events'
import { Pool } from 'pg'
import { DbConfig } from './config'

class Db extends EventEmitter {
  constructor (private readonly config: DbConfig) {
    super()

    if (config.poolSize) {
      config.max = config.poolSize
    }

    config.application_name = config.application_name || 'pgboss'
  }

  private pool: Pool

  public opened = false

  open () {
    this.pool = new Pool(this.config)
    this.pool.on('error', error => this.emit('error', error))
    this.opened = true
  }

  async close () {
    // TODO: fix, using undocumented "ending" property
    // @ts-ignore
    if (!this.pool.ending) {
      await this.pool.end()
      this.opened = false
    }
  }

  async executeSql<T = any>(text: Parameters<Pool['query']>[0], values?: Parameters<Pool['query']>[1]) {
    return this.pool.query<T>(text, values)
  }
}

// TODO: export class directly when tests are rewritten & disable esModuleInterop
export = Db
