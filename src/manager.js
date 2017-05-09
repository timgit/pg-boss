const assert = require('assert');
const EventEmitter = require('events');
const Promise = require('bluebird');
const uuid = require('uuid');

const Worker = require('./worker');
const plans = require('./plans');
const Attorney = require('./attorney');

const expireJobSuffix = plans.expireJobSuffix;

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
  }

  monitor(){
    const self = this;

    return expire().then(init);

    function expire() {
      return self.db.executeSql(self.expireCommand)
        .then(result => {
          if (result.rows.length){
            self.emit('expired-count', result.rows.length);

            return Promise.map(result.rows, job => {
              self.emit('expired-job', job);
              return self.publish(job.name + expireJobSuffix, job);
            });
          }
        });
    }

    function init() {
      if(self.stopped) return;

      self.expireTimer = setTimeout(check, self.config.expireCheckInterval);

      function check() {
        expire().catch(error => self.emit('error', error)).then(init);
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
    removeSubscription.call(this, name + expireJobSuffix);

    function removeSubscription(name){
      if(!this.subscriptions[name]) return;

      this.subscriptions[name].workers.forEach(worker => worker.stop());
      delete this.subscriptions[name];
    }
  }

  subscribe(name, ...args){

    assert(!(name in this.subscriptions), 'this job has already been subscribed on this instance.')

    let self = this;

    return getArgs(args)
      .then(({options, callback}) => register(options, callback));


    function getArgs(args) {

      let options, callback;

      try {
        assert(name, 'boss requires all jobs to have a name');

        if(args.length === 1){
          callback = args[0];
          options = {};
        } else if (args.length > 1){
          options = args[0] || {};
          callback = args[1];
        }

        assert(typeof callback === 'function', 'expected callback to be a function');

        if(options)
          assert(typeof options === 'object', 'expected config to be an object');

        options = options || {};
        options.teamSize = options.teamSize || 1;

        if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
          options = Attorney.applyNewJobCheckInterval(options);
        else
          options.newJobCheckInterval = self.config.newJobCheckInterval;

      } catch(e) {
        return Promise.reject(e);
      }

      return Promise.resolve({options, callback});
    }

    function register(options, callback) {

      let subscription = self.subscriptions[name] = {workers:[]};

      let onError = error => self.emit('error', error);

      let complete = (error, job) => {

        if(!error)
          return self.complete(job.id);

        return self.fail(job.id)
          .then(() => self.emit('failed', {job, error}));

      };

      let onJob;
      let processOneJob = job => {
        if(!job) return;

        self.emit('job', job);

        setImmediate(() => {
          try {
            callback(job, error => complete(error, job));
          } catch(error) {
            self.emit('failed', {job, error});
          }
        });
      };

      let onFetch;
      // teamSize is set, get multiple jobs with one query
      if (options.teamSize > 1) {
        onFetch = () => self.fetchMultiple(name, options.teamSize);
        onJob = jobs => {
          if (jobs) {
            jobs.map(processOneJob);
          }
        };
      } else {
        onFetch = () => self.fetch(name);
        onJob = processOneJob;
      }

      let workerConfig = {
        name,
        fetcher: onFetch,
        responder: onJob,
        error: onError,
        interval: options.newJobCheckInterval
      };

      // for(let w=0; w < options.teamSize; w++){
      let worker = new Worker(workerConfig);
      worker.start();
      subscription.workers.push(worker);
      // }
    }

  }

  onExpire(name, callback) {
    // unwrapping job in callback because we love our customers
    return this.subscribe(name + expireJobSuffix, (job, done) => callback(job.data, done));
  }

  publish(...args){
    let self = this;

    return getArgs(args)
      .then(({name, data, options}) => insertJob(name, data, options));


    function getArgs(args) {
      let name, data, options;

      try {
        if(typeof args[0] === 'string') {

          name = args[0];
          data = args[1];

          assert(typeof data !== 'function', 'publish() cannot accept a function as the payload.  Did you intend to use subscribe()?');

          options = args[2];

        } else if(typeof args[0] === 'object'){

          assert(args.length === 1, 'publish object API only accepts 1 argument');

          let job = args[0];

          assert(job, 'boss requires all jobs to have a name');

          name = job.name;
          data = job.data;
          options = job.options;
        }

        options = options || {};

        assert(name, 'boss requires all jobs to have a name');
        assert(typeof options === 'object', 'options should be an object');

      } catch (error){
        return Promise.reject(error);
      }

      return Promise.resolve({name, data, options});
    }

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
        expireIn = options.expireIn || '15 minutes';

      let singletonKey = options.singletonKey || null;

      let values = [id, name, retryLimit, startIn, expireIn, data, singletonKey, singletonSeconds, singletonOffset || 0];

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
    return this.db.executeSql(this.nextJobCommand, [ name, 1 ])
      .then(result => {
        if(result.rows.length === 0)
          return null;

        let job = result.rows[0];

        job.name = name;

        return job;
      });
  }

  // returns an array of jobs or null
  fetchMultiple(name, limit) {
    return this.db.executeSql(this.nextJobCommand, [ name, limit || 1 ])
      .then(result => {
        if(result.rows.length === 0)
          return null;

        result.rows.forEach((row) => {
          row.name = name;
        });

        return result.rows;
      });
  }

  complete(id){
    return this.db.executeSql(this.completeJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be completed.`);
        return id;
      });
  }

  cancel(id) {
    return this.db.executeSql(this.cancelJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be cancelled.`);
        return id;
      });
  }

  fail(id){
    return this.db.executeSql(this.failJobCommand, [id])
      .then(result => {
        assert(result.rowCount === 1, `Job ${id} could not be marked as failed.`);
        return id;
      });
  }
}

module.exports = Manager;
