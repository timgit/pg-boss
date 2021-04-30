const delay = require('delay')

const WORKER_STATES = {
  created: 'created',
  active: 'active',
  stopping: 'stopping',
  stopped: 'stopped'
}

class Worker {
  constructor ({ id, name, options, interval, fetch, onFetch, onError }) {
    this.id = id
    this.name = name
    this.options = options
    this.fetch = fetch
    this.onFetch = onFetch
    this.onError = onError
    this.interval = interval
    this.jobs = []
    this.createdOn = Date.now()
    this.lastFetchedOn = null
    this.lastJobStartedOn = null
    this.lastJobEndedOn = null
    this.lastError = null
    this.lastErrorOn = null
    this.state = WORKER_STATES.created
    this.stopping = false
    this.stopped = false
  }

  async start () {
    this.state = WORKER_STATES.active

    while (!this.stopping) {
      const started = Date.now()

      try {
        const jobs = await this.fetch()

        this.lastFetchedOn = Date.now()

        if (jobs) {
          this.jobs = jobs

          this.lastJobStartedOn = this.lastFetchedOn

          await this.onFetch(jobs)

          this.lastJobEndedOn = Date.now()

          this.jobs = []
        }
      } catch (err) {
        this.lastErrorOn = Date.now()
        this.lastError = err

        err.message = `${err.message} (Queue: ${this.name}, Worker: ${this.id})`

        this.onError(err)
      }

      const duration = Date.now() - started

      if (!this.stopping && duration < this.interval) {
        await delay(this.interval - duration)
      }
    }

    this.stopping = false
    this.stopped = true
    this.state = WORKER_STATES.stopped
  }

  stop () {
    this.stopping = true
    this.state = WORKER_STATES.stopping
  }
}

module.exports = Worker
