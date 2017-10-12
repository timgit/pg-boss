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
    this.completeJobsCommand = plans.completeJobs(config.schema);
    this.cancelJobCommand = plans.cancelJob(config.schema);
    this.cancelJobsCommand = plans.cancelJobs(config.schema);
    this.failJobCommand = plans.failJob(config.schema);
    this.failJobsCommand = plans.failJobs(config.schema);

    // exported api to index
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

    options.batchSize = options.batchSize || options.teamSize;

    if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
      options = Attorney.applyNewJobCheckInterval(options);
    else
      options.newJobCheckInterval = this.config.newJobCheckInterval;

    let subscription = this.subscriptions[name] = {worker:null};

    let onError = error => this.emit(events.error, error);

    let complete = (job, error, response) => {
      if(!error)
        return this.complete(job.id, response);

      return this.fail(job.id, error)
        .then(() => this.emit(events.failed, {job, error}));
    };

    let respond = jobs => {
      if (!jobs) return;

      if (!Array.isArray(jobs))
        jobs = [jobs];

      setImmediate(() => {
        jobs.forEach(job => {
          this.emit(events.job, job);
          job.done = (error, response) => complete(job, error, response);

          try {
            callback(job, job.done);
          }
          catch (error) {
            this.emit(events.failed, {job, error})
          }
        });
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

  unsubscribe(name){
    if(!this.subscriptions[name]) return Promise.reject(`No subscriptions for ${name} were found.`);

    this.subscriptions[name].worker.stop();
    delete this.subscriptions[name];

    return Promise.resolve(true);
  }

  offFail(name) {
    return this.unsubscribe(name + failedJobSuffix);
  }

  offExpire(name) {
    return this.unsubscribe(name + expiredJobSuffix);
  }

  offComplete(name){
    return this.unsubscribe(name + completedJobSuffix);
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
                      result.rows.length === 1 && !batchSize ? result.rows[0] :
                      result.rows);
  }

  fetchFailed(name, batchSize) {
    return this.fetch(name + failedJobSuffix, batchSize);
  }

  fetchExpired(name, batchSize) {
    return this.fetch(name + expiredJobSuffix, batchSize)
      .then(result => Array.isArray(result) ? result.map(this.unwrapStateJob) : this.unwrapStateJob(result));
  }

  fetchCompleted(name, batchSize){
    return this.fetch(name + completedJobSuffix, batchSize);
  }

  unwrapStateJob(job){
    return job.data;
  }

  setStateForJob(id, data, actionName, command, stateSuffix, bypassNotify){
    let job;

    return this.db.executeSql(command, [id])
      .then(result => {
        assert(result.rowCount === 1, `${actionName}(): Job ${id} could not be updated.`);

        job = result.rows[0];

        return bypassNotify
          ? null
          : this.publish(job.name + stateSuffix, {request: job, response: data || null});
      })
      .then(() => job);
  }

  setStateForJobs(ids, actionName, command){
    return this.db.executeSql(command, [ids])
      .then(result => {
        assert(result.rowCount === ids.length, `${actionName}(): ${ids.length} jobs submitted, ${result.rowCount} updated`);
      });
  }

  setState(config){
    let {id, data, actionName, command, batchCommand, stateSuffix, bypassNotify} = config;

    return Attorney.assertAsync(id, `${actionName}() requires id argument`)
      .then(() => {
        let ids = Array.isArray(id) ? id : [id];

        assert(ids.length, `${actionName}() requires at least 1 item in an array argument`);

        return ids.length === 1
          ? this.setStateForJob(ids[0], data, actionName, command, stateSuffix, bypassNotify)
          : this.setStateForJobs(ids, actionName, batchCommand);
      })
  }

  complete(id, data){
    const config = {
      id,
      data,
      actionName: 'complete',
      command: this.completeJobCommand,
      batchCommand: this.completeJobsCommand,
      stateSuffix: completedJobSuffix
    };

    return this.setState(config);
  }

  fail(id, data){
    const config = {
      id,
      data,
      actionName: 'fail',
      command: this.failJobCommand,
      batchCommand: this.failJobsCommand,
      stateSuffix: failedJobSuffix
    };

    return this.setState(config);
  }

  cancel(id) {
    const config = {
      id,
      actionName: 'cancel',
      command: this.cancelJobCommand,
      batchCommand: this.cancelJobsCommand,
      bypassNotify: true
    };

    return this.setState(config);
  }

}

module.exports = Manager;
