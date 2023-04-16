const EventEmitter = require('events')
const pg = require('pg')
const createSubscriber = require('pg-listen')

class Db extends EventEmitter {
  constructor (config) {
    super()

    config.application_name = config.application_name || 'pgboss'

    this.config = config
    this.notifier = null
  }

  async open () {
    this.pool = new pg.Pool(this.config)
    this.pool.on('error', error => this.emit('error', error))
    if (this.config.useNotify) {
      this.notifier = createSubscriber(this.config)
      this.notifier.events.on('error', error => this.emit('error', error))
      await this.notifier.connect()
    }
    this.opened = true
  }

  async close () {
    if (!this.pool.ending) {
      this.opened = false
      await this.pool.end()
      this.notifier?.close()
    }
  }

  async executeSql (text, values) {
    if (this.opened) {
      return await this.pool.query(text, values)
    }
  }

  static quotePostgresStr (str) {
    const delimeter = '$sanitize$'
    if (str.includes(delimeter)) {
      throw new Error(`Attempted to quote string that contains reserved Postgres delimeter: ${str}`)
    }
    return `${delimeter}${str}${delimeter}`
  }
}

module.exports = Db
