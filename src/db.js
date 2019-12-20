const EventEmitter = require('events')
const pg = require('pg')

class Db extends EventEmitter {
  constructor (config) {
    super()

    this.config = config

    if (config.poolSize) { config.max = config.poolSize }

    config.application_name = config.application_name || 'pgboss'

    this.pool = new pg.Pool(config)

    this.pool.on('error', error => this.emit('error', error))
  }

  async close () {
    if(!this.pool.ending) {
        await this.pool.end()    
    }
  }

  async executeSql (text, values) {
    return this.pool.query(text, values)
  }
}

module.exports = Db
