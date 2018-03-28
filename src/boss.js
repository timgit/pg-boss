const EventEmitter = require('events');
const plans = require('./plans');

const events = {
  archived: 'archived',
  deleted: 'deleted',
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
    this.purgeCommand = plans.purge(config.schema);
    this.countStatesCommand = plans.countStates(config.schema);
  }

  supervise(){
    const self = this;

    // todo: add query that calcs avg start time delta vs. creation time

    return Promise.all([
      monitor(this.archive, this.config.archiveCheckInterval),
      monitor(this.purge, this.config.deleteCheckInterval),
      monitor(this.expire, this.config.expireCheckInterval),
      this.config.monitorStateInterval ? monitor(this.countStates, this.config.monitorStateInterval) : null
    ]);

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
    let stateCountDefault = Object.assign({}, plans.states);

    Object.keys(stateCountDefault).forEach(key => stateCountDefault[key] = 0);

    return this.db.executeSql(this.countStatesCommand)
      .then(counts => {

        let states = counts.rows.reduce((acc, item) => {
            if(item.name)
              acc.queues[item.name] = acc.queues[item.name] || Object.assign({}, stateCountDefault);

            let queue = item.name ? acc.queues[item.name] : acc;
            let state = item.state || 'all';

            // parsing int64 since pg returns it as string
            queue[state] = parseFloat(item.size);

            return acc;
          },
          Object.assign({}, stateCountDefault, { queues: {} })
        );

        console.log(JSON.stringify(states, null, '  '));

        this.emit(events.monitorStates, states);

        return states;
      });
  }

  expire() {
    return this.db.executeSql(this.expireCommand)
      .then(result => {
        if (result.rows.length) {
          this.emit(events.expiredCount, result.rows.length);
          return Promise.all(result.rows.map(job => this.emit(events.expiredJob, job)));
        }
      });
  }

  archive(){
    return this.db.executeSql(this.archiveCommand, [this.config.archiveCompletedJobsEvery])
      .then(result => {
        if (result.rowCount)
          this.emit(events.archived, result.rowCount);
      });
  }

  purge(){
    return this.db.executeSql(this.purgeCommand, [this.config.deleteArchivedJobsEvery])
      .then(result => {
        if (result.rowCount)
          this.emit(events.deleted, result.rowCount);
      });
  }

}

module.exports = Boss;
