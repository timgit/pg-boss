const assert = require('assert');
const EventEmitter = require('events');
const Db = require('./db');
const uuid = require('node-uuid');
const Worker = require('./worker');
const plans = require('./plans');
const Promise = require('bluebird');

class Manager extends EventEmitter {
    constructor(config){
        super();

        this.config = config;
        this.db = new Db(config);

        this.workerInterval = config.newJobCheckIntervalSeconds * 1000;
        this.monitorInterval = config.expireCheckIntervalMinutes * 60 * 1000;
        this.nextJobCommand = plans.fetchNextJob(config.schema);
        this.expireJobCommand = plans.expireJob(config.schema);
        this.insertJobCommand = plans.insertJob(config.schema);
        this.completeJobCommand = plans.completeJob(config.schema);

        this.workers = [];
    }

    monitor(){
        var self = this;

        timeoutOldJobs();

        function timeoutOldJobs(){
            self.db.executeSql(self.expireJobCommand)
                .catch(error => self.emit('error', error))
                .then(() => setTimeout(timeoutOldJobs, self.monitorInterval));
        }
    }

    subscribe(name, config, callback){
        assert(name, 'boss requires all jobs to have a name');

        config = config || {};
        assert(typeof config == 'object', 'expected config to be an object');

        config.teamSize = config.teamSize || 1;

        let jobFetcher = () =>
            this.db.executePreparedSql('nextJob', this.nextJobCommand, name)
                .then(result => result.rows.length ? result.rows[0] : null);

        let workerConfig = {name: name, fetcher: jobFetcher, interval: this.workerInterval};

        for(let w=0;w<config.teamSize; w++){

            let worker = new Worker(workerConfig);

            worker.on('error', error => this.emit('error', error));

            worker.on(name, job => {
                job.name = name;
                this.emit('job', job);
                setImmediate(() => callback(job, () => this.completeJob(job.id)));
            });

            worker.start();

            this.workers.push(worker);
        }
    }

    publish(name, data, options){
        assert(name, 'boss requires all jobs to have a name');

        let self = this;
        
        return new Promise(deferred);
        

        function deferred(resolve, reject){

            insertJob();

            function insertJob(){
                options = options || {};

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
                    state = 'created',
                    retryLimit = options.retryLimit || 0,
                    expireIn = options.expireIn || '15 minutes',
                    singletonOffset = options.singletonOffset || 0;

                let values = [id, name, state, retryLimit, startIn, expireIn, data, singletonSeconds, singletonOffset];

                self.db.executeSql(self.insertJobCommand, values)
                    .then(result => {
                        if(result.rowCount === 1)
                            return resolve(id);

                        if(singletonSeconds && options.startIn != singletonSeconds){
                            options.startIn = singletonSeconds;
                            options.singletonOffset = singletonSeconds;

                            insertJob(name, data, options);
                        }
                        else {
                            resolve(null);
                        }
                    })
                    .catch(error => {
                        self.emit('error', error);
                        reject(error);
                    });
            }

        }

    }

    completeJob(id){
        let values = [id];

        return this.db.executeSql(this.completeJobCommand, values)
            .catch(error => {
                this.emit('error', error);
                throw error;
            });
    }
}

module.exports = Manager;