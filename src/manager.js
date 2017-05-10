const assert = require('assert');
const EventEmitter = require('events');
const Promise = require('bluebird');
const uuid = require('uuid');

const Worker = require('./worker');
const plans = require('./plans');
const Attorney = require('./attorney');

const expiredJobSuffix = plans.expiredJobSuffix;
const completedJobSuffix = plans.completedJobSuffix;
const failedJobSuffix = plans.failedJobSuffix;

const events = {
  job: 'job',
  failed: 'failed',
  error: 'error'
};

class Manager extends EventEmitter {
  constructor(db, config){
    super();

    this.config = config;
    this.db = db;

    this.events = events;
    this.subscriptions = {};

    this.nextJobCommand = plans.fetchNextJob(config.schema);
    this.insertJobCommand = plans.insertJob(config.schema);
    this.completeJobCommand = plans.completeJob(config.schema);
    this.cancelJobCommand = plans.cancelJob(config.schema);
    this.failJobCommand = plans.failJob(config.schema);

    this.offFail = name => this.unsubscribe(name + failedJobSuffix);
    this.offExpire = name => this.unsubscribe(name + expiredJobSuffix);
    this.offComplete = name => this.unsubscribe(name + completedJobSuffix);

    this.fetchFailed = (name,batchSize) => this.fetch(name + failedJobSuffix, batchSize);
    this.fetchExpired = (name,batchSize) => this.fetch(name + expiredJobSuffix, batchSize);
    this.fetchCompleted = (name,batchSize) => this.fetch(name + completedJobSuffix, batchSize);

    this.functions = [
      this.fetch,
      this.complete,
      this.cancel,
      this.fail,
      this.publish,
      this.subscribe,
      this.unsubscribe,
      this.onComplete,
      this.offComplete,
      this.onExpire,
      this.offExpire,
      this.onFail,
      this.offFail,
      this.fetchFailed,
      this.fetchExpired,
      this.fetchCompleted
    ];
  }

  stop() {
    Object.keys(this.subscriptions).forEach(name => this.unsubscribe(name));
    this.subscriptions = {};
    return Promise.resolve(true);
  }

  unsubscribe(name){
    if(!this.subscriptions[name]) return Promise.reject(`No subscriptions for ${name} were found.`);

    this.subscriptions[name].worker.stop();
    delete this.subscriptions[name];

    return Promise.resolve(true);
  }

  subscribe(name, ...args){
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name, options, callback));
  }

  onExpire(name, ...args) {
    // unwrapping job in callback here because we love our customers
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name + expiredJobSuffix, options, job => callback(job.data)));
  }

  onComplete(name, ...args) {
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name + completedJobSuffix, options, callback));
  }

  onFail(name, ...args) {
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name + failedJobSuffix, options, callback));
  }

  watch(name, options, callback){
    assert(!(name in this.subscriptions), 'this job has already been subscribed on this instance.');

    options.batchSize = options.batchSize || 1;

    if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
      options = Attorney.applyNewJobCheckInterval(options);
    else
      options.newJobCheckInterval = this.config.newJobCheckInterval;

    let subscription = this.subscriptions[name] = {worker:null};

    let onError = error => this.emit(events.error, error);

    let complete = (error, job) => {
      if(!error)
        return this.complete(job.id);

      return this.fail(job.id)
        .then(() => this.emit(events.failed, {job, error}));
    };

    let respond = jobs => {
      if(!jobs) return;

      if(!Array.isArray(jobs))
        jobs = [jobs];

      jobs.forEach(job => {
        this.emit(events.job, job);
        job.done = error => complete(error, job);
      });

      setImmediate(() => {
        try {
          let result = jobs.length === 1 ? jobs[0] : jobs;
          callback(result);
        } catch(error) {
          jobs.forEach(job => this.emit(events.failed, {job, error}));
        }
      });

    };

    let fetch = () => this.fetch(name, options.batchSize);

    let workerConfig = {
      name,
      fetch,
      respond,
      onError,
      interval: options.newJobCheckInterval
    };

    let worker = new Worker(workerConfig);
    worker.start();
    subscription.worker = worker;
  }

  publish(...args){
    return Attorney.checkPublishArgs(args)
      .then(({name, data, options}) => this.createJob(name, data, options));
  }

  expired(job){
    return this.publish(job.name + expiredJobSuffix, job);
  };

  createJob(name, data, options, singletonOffset){
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

    let id = uuid[this.config.uuid](),
      retryLimit = options.retryLimit || 0,
      expireIn = options.expireIn || '15 minutes',
      priority = options.priority || 0;

    let singletonKey = options.singletonKey || null;

    singletonOffset = singletonOffset || 0;

    let values = [id, name, priority, retryLimit, startIn, expireIn, data, singletonKey, singletonSeconds, singletonOffset];

    return this.db.executeSql(this.insertJobCommand, values)
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

        return this.createJob(name, data, options, singletonOffset);
      });
  }

  fetch(name, batchSize) {
    return Attorney.checkFetchArgs(name, batchSize)
      .then(() => this.db.executeSql(this.nextJobCommand, [name, batchSize || 1]))
      .then(result => result.rows.length === 0 ? null :
                      result.rows.length === 1 ? result.rows[0] :
                      result.rows);
  }

  complete(id, data){
    return Attorney.truthyAsync(id, 'complete() requires id argument')
        .then(() => this.db.executeSql(this.completeJobCommand, [id]))
        .then(result => {
          assert(result.rowCount === 1, `Job ${id} could not be completed.`);

          let job = result.rows[0];

          return this.respond(job, completedJobSuffix, data)
            .then(() => job);
        });
  }

  fail(id, data){
    return this.db.executeSql(this.failJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be marked as failed.`);

        let job = result.rows[0];

        return this.respond(job, failedJobSuffix, data)
          .then(() => job);
      });
  }

  respond(job, suffix, data){
      let payload = {
          request: job,
          response: data || null
      };

      return this.publish(job.name + suffix, payload);
  }

  cancel(id) {
    return this.db.executeSql(this.cancelJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be cancelled.`);
        return result.rows[0];
      });
  }

}

module.exports = Manager;
