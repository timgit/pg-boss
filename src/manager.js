const assert = require('assert');
const EventEmitter = require('events');
const Promise = require('bluebird');

const Worker = require('./worker');
const plans = require('./plans');
const Attorney = require('./attorney');

const completedJobSuffix = plans.completedJobSuffix;

const events = {
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
    this.completeJobsCommand = plans.completeJobs(config.schema);
    this.cancelJobsCommand = plans.cancelJobs(config.schema);
    this.failJobsCommand = plans.failJobs(config.schema);
    this.deleteQueueCommand = plans.deleteQueue(config.schema);
    this.deleteAllQueuesCommand = plans.deleteAllQueues(config.schema);

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
      this.fetchCompleted,
      this.publishDebounced,
      this.publishThrottled,
      this.deleteQueue,
      this.deleteAllQueues
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

  onComplete(name, ...args) {
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name + completedJobSuffix, options, callback));
  }

  watch(name, options, callback){
    assert(!(name in this.subscriptions), 'this job has already been subscribed on this instance.');

    if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
      options = Attorney.applyNewJobCheckInterval(options);
    else
      options.newJobCheckInterval = this.config.newJobCheckInterval;

    let sendItBruh = (jobs) => {
        if (!jobs)
          return Promise.resolve();

        return (options.batchSize)
              ? Promise.all([callback(jobs)])
              : Promise.mapSeries(jobs, job => callback(job));
    };

    let workerConfig = {
      name,
      fetch: () => this.fetch(name, options.batchSize || options.teamSize || 1),
      onFetch: jobs => sendItBruh(jobs).catch(err => null), // just send it, bruh
      onError: error => this.emit(events.error, error),
      interval: options.newJobCheckInterval
    };

    let worker = new Worker(workerConfig);
    worker.start();

    let subscription = this.subscriptions[name] = {worker:null};
    subscription.worker = worker;

    return Promise.resolve(true);
  }

  unsubscribe(name){
    if(!this.subscriptions[name]) return Promise.reject(`No subscriptions for ${name} were found.`);

    this.subscriptions[name].worker.stop();
    delete this.subscriptions[name];

    return Promise.resolve(true);
  }

  offComplete(name){
    return this.unsubscribe(name + completedJobSuffix);
  }

  publish(...args){
    return Attorney.checkPublishArgs(args)
      .then(({name, data, options}) => this.createJob(name, data, options));
  }

  publishThrottled(...args) {
    return Attorney.checkPublishArgs(args)
      .then(({name, data, options}) => {
        // TODO: force throttle options
        return this.createJob(name, data, options)
      });
  }

  publishDebounced(...args) {
    return Attorney.checkPublishArgs(args)
      .then(({name, data, options}) => {
        // TODO: force debounce options
        return this.createJob(name, data, options);
      });
  }

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

    let id = require(`uuid/${this.config.uuid}`)(),
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
    const names = Array.isArray(name) ? name : [name];

    return Attorney.checkFetchArgs(names, batchSize)
      .then(() => this.db.executeSql(this.nextJobCommand, [names, batchSize || 1]))
      .then(result => {

        const jobs = result.rows.map(job => {
          job.done = (error, response) => error ? this.fail(job.id, error) : this.complete(job.id, response);
          return job;
        });

        return jobs.length === 0 ? null :
               jobs.length === 1 && !batchSize ? jobs[0] :
               jobs;
      });
  }

  fetchCompleted(name, batchSize){
    return this.fetch(name + completedJobSuffix, batchSize);
  }

  mapCompletionIdArg(id, funcName) {
    const errorMessage = `${funcName}() requires an id`;

    return Attorney.assertAsync(id, errorMessage)
      .then(() => {
        let ids = Array.isArray(id) ? id : [id];
        assert(ids.length, errorMessage);
        return ids;
      });
  }

  mapCompletionDataArg(data) {
    if(data === null || typeof data === 'undefined' || typeof data === 'function')
      return null;

    return (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value:data };
  }

  mapCompletionResponse(ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      updated: result.rowCount
    };
  }

  complete(id, data){
    return this.mapCompletionIdArg(id, 'complete')
      .then(ids => this.db.executeSql(this.completeJobsCommand, [ids, this.mapCompletionDataArg(data)])
                    .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  fail(id, data){
    return this.mapCompletionIdArg(id, 'fail')
      .then(ids => this.db.executeSql(this.failJobsCommand, [ids, this.mapCompletionDataArg(data)])
        .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  cancel(id) {
    return this.mapCompletionIdArg(id, 'cancel')
      .then(ids => this.db.executeSql(this.cancelJobsCommand, [ids])
        .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  deleteQueue(queue){
    return this.db.executeSql(this.deleteQueueCommand, [queue]);
  }

  deleteAllQueues(){
    return this.db.executeSql(this.deleteAllQueuesCommand);
  }

}

module.exports = Manager;
