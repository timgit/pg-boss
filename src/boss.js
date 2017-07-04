const EventEmitter = require('events');
const plans = require('./plans');
const Promise = require('bluebird');

const events = {
  archived: 'archived',
  monitorStates: 'monitor-states',
  expiredCount: 'expired-count',
  expiredJob: 'expired-job',
  error: 'error'
};

class Boss extends EventEmitter{
  constructor(db, config){
    super();

    this.db = db;
    this.config = config;

    this.timers = {};
    this.events = events;

    this.expireCommand = plans.expire(config.schema);
    this.archiveCommand = plans.archive(config.schema);
    this.countStatesCommand = plans.countStates(config.schema);
  }

  supervise(){
    const self = this;

    // todo: add query that calcs avg start time delta vs. creation time

    return Promise.join(
      monitor(this.archive, this.config.archiveCheckInterval),
      monitor(this.expire, this.config.expireCheckInterval),
      this.config.monitorStateInterval ? monitor(this.countStates, this.config.monitorStateInterval) : null
    );

    function monitor(func, interval) {

      return exec().then(repeat);

      function exec() {
        return func.call(self).catch(error => self.emit(events.error, error));
      }

      function repeat(){
        if(self.stopped) return;
        self.timers[func.name] = setTimeout(() => exec().then(repeat), interval);
      }
    }
  }

  stop() {
    this.stopped = true;
    Object.keys(this.timers).forEach(key => clearTimeout(this.timers[key]));
    return Promise.resolve();
  }

  countStates(){
    return this.db.executeSql(this.countStatesCommand)
      .then(result => {
        let states = result.rows[0];
        // parsing int64 since pg returns it as string
        Object.keys(states).forEach(state => states[state] = parseFloat(states[state]));
        this.emit(events.monitorStates, states);
        return states;
      });
  }

  expire() {
    return this.db.executeSql(this.expireCommand)
      .then(result => {
        if (result.rows.length) {
          this.emit(events.expiredCount, result.rows.length);
          return Promise.map(result.rows, job => this.emit(events.expiredJob, job));
        }
      });
  }

  archive(){
    return this.db.executeSql(this.archiveCommand, this.config.archiveCompletedJobsEvery)
      .then(result => {
        if (result.rowCount)
          this.emit(events.archived, result.rowCount);
      });
  }

}

module.exports = Boss;
