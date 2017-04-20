const assert = require('assert');
const EventEmitter = require('events');
const Promise = require('bluebird');
const uuid = require('uuid');

const Worker = require('./worker');
const plans = require('./plans');
const Attorney = require('./attorney');

const expiredJobSuffix = plans.expiredJobSuffix;
const completedJobSuffix = plans.completedJobSuffix;

const events = {
  job: 'job',
  expiredCount: 'expired-count',
  expiredJob: 'expired-job',
  failed: 'failed',
  error: 'error'
};

class Manager extends EventEmitter {
  constructor(db, config){
    super();

    this.config = config;
    this.db = db;

    this.nextJobCommand = plans.fetchNextJob(config.schema);
    this.expireCommand = plans.expire(config.schema);
    this.insertJobCommand = plans.insertJob(config.schema);
    this.completeJobCommand = plans.completeJob(config.schema);
    this.cancelJobCommand = plans.cancelJob(config.schema);
    this.failJobCommand = plans.failJob(config.schema);

    this.subscriptions = {};

    this.promotedEvents = Object.keys(events).map(key => events[key]);
  }

  monitor(){
    const self = this;

    return expire().then(init);

    function expire() {
      return self.db.executeSql(self.expireCommand)
        .then(result => {
          if (result.rows.length){
            self.emit(events.expiredCount, result.rows.length);

            return Promise.map(result.rows, job => {
              self.emit(events.expiredJob, job);
              return self.publish(job.name + expiredJobSuffix, job);
            });
          }
        });
    }

    function init() {
      if(self.stopped) return;

      self.expireTimer = setTimeout(check, self.config.expireCheckInterval);

      function check() {
        expire().catch(error => self.emit(events.error, error)).then(init);
      }
    }
  }

  close() {
    Object.keys(this.subscriptions)
      .forEach(name => this.unsubscribe(name));

    this.subscriptions = {};

    return Promise.resolve(true);
  }

  stop() {
    return this.close().then(() => {
      this.stopped = true;

      if(this.expireTimer)
        clearTimeout(this.expireTimer);
    });
  }

  unsubscribe(name){
    assert(name in this.subscriptions, 'subscription not found for job ' + name);

    removeSubscription.call(this, name);

    function removeSubscription(name){
      if(!this.subscriptions[name]) return;

      this.subscriptions[name].workers.forEach(worker => worker.stop());
      delete this.subscriptions[name];
    }
  }

  subscribe(name, ...args){

    return Attorney.getSubscribeArgs(args)
      .then(({options, callback}) => {

        assert(name, 'missing job name');
        assert(!(name in this.subscriptions), 'this job has already been subscribed on this instance.');

        options.teamSize = options.teamSize || 1;

        if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
          options = Attorney.applyNewJobCheckInterval(options);
        else
          options.newJobCheckInterval = this.config.newJobCheckInterval;

        return register.call(this, options, callback);

      });


    function register(options, callback) {

      let subscription = this.subscriptions[name] = {workers:[]};

      let onError = error => this.emit(events.error, error);

      let complete = (error, job) => {

        if(!error)
          return this.complete(job.id);

        return this.fail(job.id)
          .then(() => this.emit(events.failed, {job, error}));

      };

      let onJob = job => {
        if(!job) return;

        this.emit(events.job, job);

        setImmediate(() => {
          try {
            callback(job, error => complete(error, job));
          } catch(error) {
            this.emit(events.failed, {job, error});
          }
        });

      };

      let onFetch = () => this.fetch(name);

      let workerConfig = {
        name,
        fetcher: onFetch,
        responder: onJob,
        error: onError,
        interval: options.newJobCheckInterval
      };

      for(let w=0; w < options.teamSize; w++){
        let worker = new Worker(workerConfig);
        worker.start();
        subscription.workers.push(worker);
      }
    }

  }

  onExpire(name, ...args) {
    return Attorney.getSubscribeArgs(args)
      .then(({options, callback}) => {
        // unwrapping job in callback because we love our customers
        return this.subscribe(name + expiredJobSuffix, options, (job, done) => callback(job.data, done));
      });
  }

  onComplete(name, ...args) {
    return Attorney.getSubscribeArgs(args)
      .then(({options, callback}) => this.subscribe(name + completedJobSuffix, options, callback));
  }

  publish(...args){
    let self = this;

    return Attorney.getPublishArgs(args)
      .then(({name, data, options}) => insertJob(name, data, options));

    function insertJob(name, data, options, singletonOffset){
      let startIn =
        (options.startIn > 0) ? '' + options.startIn
          : (typeof options.startIn === 'string') ? options.startIn
          : '0';

      let singletonSeconds =
        (options.singletonSeconds > 0) ? options.singletonSeconds
          : (options.singletonMinutes > 0) ? options.singletonMinutes * 60
          : (options.singletonHours > 0) ? options.singletonHours * 60 * 60
            : (options.singletonDays > 0) ? options.singletonDays * 60 * 60 * 24
              : null;

      let id = uuid[self.config.uuid](),
        retryLimit = options.retryLimit || 0,
        expireIn = options.expireIn || '15 minutes',
        priority = options.priority || 0;

      let singletonKey = options.singletonKey || null;

      singletonOffset = singletonOffset || 0;

      let values = [id, name, priority, retryLimit, startIn, expireIn, data, singletonKey, singletonSeconds, singletonOffset];

      return self.db.executeSql(self.insertJobCommand, values)
        .then(result => {
          if(result.rowCount === 1)
            return id;

          if(!options.singletonNextSlot)
            return null;

          // delay starting by the offset to honor throttling config
          options.startIn = singletonSeconds;
          // toggle off next slot config for round 2
          options.singletonNextSlot = false;

          let singletonOffset = singletonSeconds;

          return insertJob(name, data, options, singletonOffset);
        });
    }

  }

  fetch(name) {
    return this.db.executeSql(this.nextJobCommand, name)
      .then(result => {
        if(result.rows.length === 0)
          return null;

        let job = result.rows[0];

        job.name = name;

        return job;
      });
  }

  complete(id, data){
    return this.db.executeSql(this.completeJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be completed.`);
        let job = result.rows[0];

        if(data){
          this.publish(job.name + completedJobSuffix, {
            request: job,
            response: data
          });
        }

        return job;
      });
  }

  cancel(id) {
    return this.db.executeSql(this.cancelJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be cancelled.`);
        return result.rows[0];
      });
  }

  fail(id){
    return this.db.executeSql(this.failJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be marked as failed.`);
        return result.rows[0];
      });
  }
}

module.exports = Manager;
