const Promise = require('bluebird')

class Worker {
  constructor (config) {
    this.config = config
  }

  async start () {
    if (!this.stopped) {
      await this.config.fetch().then(this.config.onFetch).catch(this.config.onError)
      await Promise.delay(this.config.interval)

      this.start()
    }
  }

  stop () {
    this.stopped = true
  }
}

module.exports = Worker
