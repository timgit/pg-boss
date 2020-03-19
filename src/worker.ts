import { delay } from 'bluebird'

interface WorkerConfig {
  name: string
  interval: number
  fetch: () => Promise<any>
  onFetch: () => Promise<any>
  onError: () => any
}

class Worker {
  constructor(private config: WorkerConfig) {}

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