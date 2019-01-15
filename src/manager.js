const assert = require('assert');
const EventEmitter = require('events');
const Promise = require('bluebird');

const Worker = require('./worker');
const plans = require('./plans');
const Attorney = require('./attorney');

const completedJobPrefix = plans.completedJobPrefix;

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
      this.publishOnce,
      this.publishAfter,
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
      .then(({options, callback}) => this.watch(completedJobPrefix + name, options, callback));
  }

  watch(name, options, callback){
    // watch() is always nested in a promise, so assert()s are welcome

    if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
      options = Attorney.applyNewJobCheckInterval(options);
    else
      options.newJobCheckInterval = this.config.newJobCheckInterval;

    if('teamConcurrency' in options){
      const teamConcurrencyErrorMessage = 'teamConcurrency must be an integer between 1 and 1000';
      assert(Number.isInteger(options.teamConcurrency) && options.teamConcurrency >= 1 && options.teamConcurrency <= 1000, teamConcurrencyErrorMessage);
    }

    if('teamSize' in options){
      const teamSizeErrorMessage = 'teamSize must be an integer > 0';
      assert(Number.isInteger(options.teamSize) && options.teamSize >= 1, teamSizeErrorMessage);
    }

    if('batchSize' in options) {
      const batchSizeErrorMessage = 'batchSize must be an integer > 0';
      assert(Number.isInteger(options.batchSize) && options.batchSize >= 1, batchSizeErrorMessage);
    }

    let sendItBruh = (jobs) => {
        if (!jobs)
          return Promise.resolve();

        // If you get a batch, for now you should use complete() so you can control
        //   whether individual or group completion responses apply to your use case
        // Failing will fail all fetched jobs
        if(options.batchSize)
          return Promise.all([callback(jobs)]).catch(err => this.fail(jobs.map(job => job.id), err));

        // either no option was set, or teamSize was used
        return Promise.map(jobs, job => {
          return callback(job).then(value => this.complete(job.id, value)).catch(err => this.fail(job.id, err))
        }, {concurrency: options.teamConcurrency || 2});
    };

    let onError = error => this.emit(events.error, error);

    let workerConfig = {
      name,
      fetch: () => this.fetch(name, options.batchSize || options.teamSize || 1),
      onFetch: jobs => sendItBruh(jobs).catch(err => null), // just send it, bruh
      onError,
      interval: options.newJobCheckInterval
    };

    let worker = new Worker(workerConfig);
    worker.start();

    if(!this.subscriptions[name])
      this.subscriptions[name] = { workers: [] };

    this.subscriptions[name].workers.push(worker);

    return Promise.resolve(true);
  }

  unsubscribe(name){
    if(!this.subscriptions[name]) return Promise.reject(`No subscriptions for ${name} were found.`);

    this.subscriptions[name].workers.forEach(worker => worker.stop());
    delete this.subscriptions[name];

    return Promise.resolve(true);
  }

  offComplete(name){
    return this.unsubscribe(completedJobPrefix + name);
  }

  publish(...args){
    return Attorney.checkPublishArgs(args)
      .then(({name, data, options}) => this.createJob(name, data, options));
  }

  publishOnce(name, data, options, key) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.singletonKey = key;

        return this.createJob(name, data, options);
      });
  }

  publishAfter(name, data, options, after) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.startAfter = after;

        return this.createJob(name, data, options);
      });
  }

  publishThrottled(name, data, options, seconds, key) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.singletonSeconds = seconds;
        options.singletonNextSlot = false;
        options.singletonKey = key;

        return this.createJob(name, data, options);
      });
  }

  publishDebounced(name, data, options, seconds, key) {
    return Attorney.checkPublishArgs([name, data, options])
      .then(({name, data, options}) => {

        options.singletonSeconds = seconds;
        options.singletonNextSlot = true;
        options.singletonKey = key;

        return this.createJob(name, data, options);
      });
  }

  createJob(name, data, options, singletonOffset){

    let startAfter = options.startAfter;

    startAfter = (startAfter instanceof Date && typeof startAfter.toISOString === 'function') ? startAfter.toISOString()
      : (startAfter > 0) ? '' + startAfter
      : (typeof startAfter === 'string') ? startAfter
      : null;

    if('retryDelay' in options)
        assert(Number.isInteger(options.retryDelay) && options.retryDelay >= 0, 'retryDelay must be an integer >= 0');

    if('retryBackoff' in options)
      assert(options.retryBackoff === true || options.retryBackoff === false, 'retryBackoff must be either true or false');

    if('retryLimit' in options)
      assert(Number.isInteger(options.retryLimit) && options.retryLimit >= 0, 'retryLimit must be an integer >= 0');

    let retryLimit = options.retryLimit || 0;
    let retryBackoff = !!options.retryBackoff;
    let retryDelay = options.retryDelay || 0;

    if(retryBackoff && !retryDelay)
      retryDelay = 1;

    if(retryDelay && !retryLimit)
      retryLimit = 1;

    let expireIn = options.expireIn || '15 minutes';
    let priority = options.priority || 0;

    let singletonSeconds =
      (options.singletonSeconds > 0) ? options.singletonSeconds
        : (options.singletonMinutes > 0) ? options.singletonMinutes * 60
        : (options.singletonHours > 0) ? options.singletonHours * 60 * 60
          : null;

    let singletonKey = options.singletonKey || null;

    singletonOffset = singletonOffset || 0;

    let id = require(`uuid/${this.config.uuid}`)();

    // ordinals! [1,  2,    3,        4,          5,          6,        7,    8,            9,                10,              11,         12          ]
    let values = [id, name, priority, retryLimit, startAfter, expireIn, data, singletonKey, singletonSeconds, singletonOffset, retryDelay, retryBackoff];

    return this.db.executeSql(this.insertJobCommand, values)
      .then(result => {
        if(result.rowCount === 1)
          return result.rows[0].id;

        if(!options.singletonNextSlot)
          return null;

        // delay starting by the offset to honor throttling config
        options.startAfter = singletonSeconds;
        // toggle off next slot config for round 2
        options.singletonNextSlot = false;

        let singletonOffset = singletonSeconds;

        return this.createJob(name, data, options, singletonOffset);
      });
  }

  fetch(name, batchSize) {
    return Attorney.checkFetchArgs(name, batchSize)
      .then(values => this.db.executeSql(this.nextJobCommand, [values.name, values.batchSize || 1]))
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
    return this.fetch(completedJobPrefix + name, batchSize);
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

    if(data instanceof Error)
      data = JSON.parse(JSON.stringify(data, Object.getOwnPropertyNames(data)));

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
