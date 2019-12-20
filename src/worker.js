const Promise = require('bluebird')

class Worker {
  constructor (config) {
    this.config = config
  }

  async start () {
    if (this.stopped) {
      return
    }

    try {
      const result = await this.config.fetch()
      await this.config.onFetch(result)
    } catch (error) {
      this.config.onError(error)
    }

    await Promise.delay(this.config.interval)

    this.start()
  }

  stop () {
    this.stopped = true
  }
}

module.exports = Worker
