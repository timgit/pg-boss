class Worker {
  constructor(config){
    this.config = config;
  }

  start() {
    if(this.stopped) return;

    this.config.fetch()
      .then(this.config.onFetch)
      .catch(this.config.onError)
      .then(() => setTimeout(() => this.start.apply(this), this.config.interval));
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = Worker;
