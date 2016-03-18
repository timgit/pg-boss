const assert = require('assert');
const EventEmitter = require('events');
const Db = require('./db');
const uuid = require('node-uuid');
const Worker = require('./worker');
const plans = require('./plans');

class Manager extends EventEmitter {
    constructor(config){
        super();

        this.config = config;

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
        let db = new Db(self.config);

        timeoutOldJobs();

        function timeoutOldJobs(){
            return db.executeSql(self.expireJobCommand)
                .catch(error => self.emit('error', error))
                .then(() => setTimeout(timeoutOldJobs, self.monitorInterval));
        }
    }

    subscribe(name, config, callback){
        assert(name, 'boss requires all jobs to have a name');

        config = config || {};
        assert(typeof config == 'object', 'expected config to be an object');

        config.teamSize = config.teamSize || 1;

        let db = new Db(this.config);

        let jobFetcher = () =>
            db.executeSql(this.nextJobCommand, name)
                .then(result => result.rows.length ? result.rows[0] : null);

        let workerConfig = {name: name, fetcher: jobFetcher, interval: this.workerInterval};

        for(let w=0;w<config.teamSize; w++){

            let worker = new Worker(workerConfig);

            worker.on('error', error => this.emit('error', error));

            worker.on(name, job => {
                this.emit('job', {name, id: job.id});

                callback(job, () => this.completeJob(job.id));
            });

            this.workers.push(worker);
        }
    }

    publish(name, data, options){
        options = options || {};

        options.startIn =
            (options.startIn > 0) ? options.startIn = '' + options.startIn
            : (typeof options.startIn == 'string') ? options.startIn
            : '0';

        let id = uuid[this.config.uuid](),
            state = 'created',
            retryLimit = options.retryLimit || 0,
            startIn = options.startIn || '0',
            expireIn = options.expireIn || '15 minutes';

        let values = [id, name, state, retryLimit, startIn, expireIn, data];

        let db = new Db(this.config);

        return db.executeSql(this.insertJobCommand, values)
            .then(() => id)
            .catch(error => this.emit('error', error));
    }

    completeJob(id){
        let values = [id];

        let db = new Db(this.config);

        return db.executeSql(this.completeJobCommand, values)
            .catch(error => this.emit('error', error));
    }
}

module.exports = Manager;