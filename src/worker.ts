import { delay } from 'bluebird'
import { WorkerConfig } from './config'

class Worker {
  constructor (private readonly config: WorkerConfig) {}

  private stopped = false

  async start () {
    while (!this.stopped) {
      await this.config.fetch().then(this.config.onFetch).catch(this.config.onError)
      await delay(this.config.interval)
    }
  }

  stop () {
    this.stopped = true
  }
}

export = Worker
