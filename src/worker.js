const delay = require('delay')

class Worker {
  constructor (config) {
    this.config = config
  }

  async start () {
    while (!this.stopped) {
      const started = Date.now()

      await this.config.fetch().then(this.config.onFetch).catch(this.config.onError)

      const duration = Date.now() - started

      if (duration < this.config.interval) {
        await delay(this.config.interval - duration)
      }
    }
  }

  stop () {
    this.stopped = true
  }
}

module.exports = Worker
