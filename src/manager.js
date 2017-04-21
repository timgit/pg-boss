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
      this.offFail
    ];
  }

  stop() {
    Object.keys(this.subscriptions).forEach(name => this.unsubscribe(name));
    this.subscriptions = {};
    return Promise.resolve(true);
  }

  unsubscribe(name){
    if(!this.subscriptions[name]) return Promise.reject(`No subscriptions for ${name} were found.`);

    this.subscriptions[name].workers.forEach(worker => worker.stop());
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
      .then(({options, callback}) => this.watch(name + expiredJobSuffix, options, (job, done) => callback(job.data, done)));
  }

  offExpire(name){
    return this.unsubscribe(name + expiredJobSuffix);
  }

  offComplete(name){
    return this.unsubscribe(name + completedJobSuffix);
  }

  offFail(name){
    return this.unsubscribe(name + failedJobSuffix);
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

    options.teamSize = options.teamSize || 1;

    if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
      options = Attorney.applyNewJobCheckInterval(options);
    else
      options.newJobCheckInterval = this.config.newJobCheckInterval;

    let subscription = this.subscriptions[name] = {workers:[]};

    let onError = error => this.emit(events.error, error);

    let complete = (error, job) => {
      if(!error)
        return this.complete(job.id);

      return this.fail(job.id)
        .then(() => this.emit(events.failed, {job, error}));
    };

    let respond = job => {
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

    let fetch = () => this.fetch(name);

    let workerConfig = {
      name,
      fetch,
      respond,
      onError,
      interval: options.newJobCheckInterval
    };

    for(let w=0; w < options.teamSize; w++){
      let worker = new Worker(workerConfig);
      worker.start();
      subscription.workers.push(worker);
    }
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
