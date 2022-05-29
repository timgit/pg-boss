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
    this.loopDelayPromise = null
    this.beenNotified = false
  }

  notify () {
    this.beenNotified = true

    if (this.loopDelayPromise) {
      this.loopDelayPromise.clear()
    }
  }

  async start () {
    this.state = WORKER_STATES.active

    while (!this.stopping) {
      const started = Date.now()

      try {
        this.beenNotified = false
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

      this.lastJobDuration = duration

      if (!this.stopping && !this.beenNotified && duration < this.interval) {
        this.loopDelayPromise = delay(this.interval - duration)
        await this.loopDelayPromise
        this.loopDelayPromise = null
      }
    }

    this.stopping = false
    this.stopped = true
    this.state = WORKER_STATES.stopped
  }

  stop () {
    this.stopping = true
    this.state = WORKER_STATES.stopping

    if (this.loopDelayPromise) {
      this.loopDelayPromise.clear()
    }
  }
}

module.exports = Worker
