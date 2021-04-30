const delay = require('delay')

class Worker {
  constructor (config) {
    this.config = config
  }

  async start () {
    while (!this.stopping) {
      const started = Date.now()

      try {
        const jobs = await this.config.fetch()
        await this.config.onFetch(jobs)
      } catch (err) {
        this.config.onError(err)
      }

      const duration = Date.now() - started

      if (!this.stopping && duration < this.config.interval) {
        await delay(this.config.interval - duration)
      }
    }

    this.stopped = true
  }

  stop () {
    this.stopping = true
  }
}

module.exports = Worker
