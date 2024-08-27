const EventEmitter = require('node:events')
const pg = require('pg')

class Db extends EventEmitter {
  constructor (config) {
    super()

    config.application_name = config.application_name || 'pgboss'

    this.config = config
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

  async executeSql (text, values) {
    if (this.opened) {
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
}

module.exports = Db
