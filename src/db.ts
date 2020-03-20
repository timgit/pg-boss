import { EventEmitter } from 'events'
import { Pool, PoolConfig } from 'pg'

interface DbConfig extends PoolConfig {
  poolSize?: number
  schema?: string
}

class Db extends EventEmitter {
  constructor(private config: DbConfig) {
    super()

    if (config.poolSize) {
      config.max = config.poolSize
    }

    config.application_name = config.application_name || 'pgboss'
  }

  private pool: Pool

  public opened = false

  async open () {
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

  async executeSql(text: Parameters<Pool['query']>[0], values?: Parameters<Pool['query']>[1]) {
    return this.pool.query(text, values)
  }
}

// TODO: export class directly when tests are rewritten & disable esModuleInterop
export = Db
