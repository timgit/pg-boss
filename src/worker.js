const delay = require('delay')

class Worker {
  constructor (config) {
    Object.assign(this, config)
  }

  async start () {
    while (!this.stopping) {
      const started = Date.now()

      try {
        const jobs = await this.fetch()

        if (jobs) {
          await this.onFetch(jobs)
        }
      } catch (err) {
        this.onError(err)
      }

      const duration = Date.now() - started

      if (!this.stopping && duration < this.interval) {
        await delay(this.interval - duration)
      }
    }

    this.stopped = true
  }

  stop () {
    this.stopping = true
  }
}

module.exports = Worker
