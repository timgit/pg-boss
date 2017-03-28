class Worker {
  constructor(config){
    this.config = config;
  }

  start() {
    if(this.stopped) return;

    this.config.fetcher()
      .then(this.config.responder)
      .catch(this.config.error)
      .then(() => setTimeout(() => this.start.apply(this), this.config.interval));
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = Worker;
