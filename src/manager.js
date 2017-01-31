const assert = require('assert');
const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;
const Promise = require('bluebird');
const uuid = require('uuid');

const Db = require('./db');
const Worker = require('./worker');
const plans = require('./plans');


class Manager extends EventEmitter {
    constructor(config){
        super();

        this.config = config;
        this.db = new Db(config);

        this.nextJobCommand = plans.fetchNextJob(config.schema);
        this.expireJobCommand = plans.expireJob(config.schema);
        this.insertJobCommand = plans.insertJob(config.schema);
        this.completeJobCommand = plans.completeJob(config.schema);
        this.cancelJobCommand = plans.cancelJob(config.schema);

        this.workers = [];
    }

    monitor(){
        var self = this;

        return expire().then(init);

        function expire() {
            return self.db.executeSql(self.expireJobCommand)
                .then(result => {
                    if (result.rowCount)
                        self.emit('expired', result.rowCount);
                });
        }

        function init() {

            if(self.stopped)
                return;

            self.expireTimer = setTimeout(check, self.config.expireCheckInterval);

            function check() {
                expire().catch(error => self.emit('error', error)).then(init);
            }
        }
    }

    close() {
        this.workers.forEach(worker => worker.stop());
        this.workers.length = 0;
        return Promise.resolve(true);
    }

    stop() {
        this.close().then(() => {
            this.stopped = true;
            
            if(this.expireTimer)
                clearTimeout(this.expireTimer);
        });
    }

    subscribe(name, ...args){

        let self = this;

        return new Promise(deferred);

        function deferred(resolve, reject){
            var options, callback;

            init();

            register();

            resolve();

            function init() {

                try {
                    assert(name, 'boss requires all jobs to have a name');

                    if(args.length === 1){
                        callback = args[0];
                        options = {};
                    } else if (args.length === 2){
                        options = args[0] || {};
                        callback = args[1];
                    }

                    assert(typeof callback == 'function', 'expected a callback function');

                    if(options)
                        assert(typeof options == 'object', 'expected config to be an object');

                    options = options || {};
                    options.teamSize = options.teamSize || 1;
                } catch(e) {
                    reject(e);
                }

            }

            function register() {
                let jobFetcher = () => self.fetch(name);

                let workerConfig = {name: name, fetcher: jobFetcher, interval: self.config.newJobCheckInterval};

                for(let w=0; w < options.teamSize; w++){

                    let worker = new Worker(workerConfig);

                    worker.on('error', error => self.emit('error', error));

                    worker.on(name, job => {
                        self.emit('job', job);
                        setImmediate(() => callback(job, () => self.complete(job.id)));
                    });

                    worker.start();

                    self.workers.push(worker);
                }
            }
        }

    }

    publish(...args){
        let self = this;
        
        return new Promise(deferred);

        function deferred(resolve, reject){

            var name, data, options;

            init();

            insertJob();

            function init() {
                try {
                    if(typeof args[0] == 'string') {

                        name = args[0];
                        data = args[1];

                        assert(typeof data != 'function', 'publish() cannot accept a function as the payload.  Did you intend to use subscribe()?');

                        options = args[2];

                    } else if(typeof args[0] == 'object'){

                        assert(args.length === 1, 'publish object API only accepts 1 argument');

                        var job = args[0];

                        assert(job, 'boss requires all jobs to have a name');

                        name = job.name;
                        data = job.data;
                        options = job.options;
                    }

                    options = options || {};

                    assert(name, 'boss requires all jobs to have a name');
                    assert(typeof options == 'object', 'options should be an object');

                } catch (error){
                    return reject(error);
                }
            }

            function insertJob(){
                let startIn =
                    (options.startIn > 0) ? '' + options.startIn
                        : (typeof options.startIn == 'string') ? options.startIn
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

                let values = [id, name, retryLimit, startIn, expireIn, data, singletonSeconds];

                self.db.executeSql(self.insertJobCommand, values)
                    .then(result => resolve(result.rowCount === 1 ? id : null))
                    .catch(reject);
            }

        }

    }

    fetch(name) {
        return this.db.executePreparedSql('nextJob', this.nextJobCommand, name)
            .then(result => {
                if(result.rows.length === 0)
                    return null;

                let job = result.rows[0];

                job.name = name;

                return job;
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
}

module.exports = Manager;