const delay = require('delay')

class Worker {
  constructor (config) {
    this.config = config
  }

  async start () {
    while (!this.stopped) {
      const started = Date.now()

      try {
        const jobs = await this.config.fetch()
        await this.config.onFetch(jobs)
      } catch (err) {
        this.config.onError(err)
      }

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
