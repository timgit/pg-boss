const EventEmitter = require('events');
const plans = require('./plans');
const Promise = require("bluebird");

const events = {
  archived: 'archived',
  monitorStates: 'monitor-states',
  error: 'error'
};

class Boss extends EventEmitter{
  constructor(db, config){
    super();

    this.db = db;
    this.config = config;

    this.archiveCommand = plans.archive(config.schema);
    this.countStatesCommand = plans.countStates(config.schema);
    this.timers = {};

    this.promotedEvents = Object.keys(events).map(key => events[key]);
  }

  supervise(){
    const self = this;

    // todo: add query that calcs avg start time delta vs. creation time

    return this.archive()
      .then(() => {
        if(this.config.monitorStateInterval)
          monitor(this.countStates, this.config.monitorStateInterval);

        monitor(this.archive, this.config.archiveCheckInterval);
      });

    function monitor(func, interval) {
      if(self.stopped) return;

      self.timers[func.name] = setTimeout(() => {
        func.call(self).catch(error => self.emit(events.error, error))
          .then(() => monitor(func, interval));
      }, interval);
    }
  }

  countStates(){
    return this.db.executeSql(this.countStatesCommand)
      .then(result => this.emit(events.monitorStates, result.rows[0]));
  }

  archive(){
    return this.db.executeSql(this.archiveCommand, this.config.archiveCompletedJobsEvery)
      .then(result => {
        if (result.rowCount)
          this.emit(events.archived, result.rowCount);
      });
  }

  stop() {
    this.stopped = true;

    Object.keys(this.timers).forEach(key => clearTimeout(this.timers[key]));

    return Promise.resolve();
  }

}

module.exports = Boss;
