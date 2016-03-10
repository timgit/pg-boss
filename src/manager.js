const assert = require('assert');
const EventEmitter = require('events');
const Db = require('./db');
const uuid = require('node-uuid');
const Worker = require('./worker');

class Manager extends EventEmitter {
    constructor(config){
        super();

        this.config = config;
        this.monitorInterval = 1000 * 60;
        this.workers = [];
    }

    monitor(){
        var self = this;

        setImmediate(timeoutOldJobs);
        setInterval(timeoutOldJobs, self.monitorInterval);

        function timeoutOldJobs(){

            const timeoutCommand = `
                UPDATE pdq.job
                SET state = 'timeout'
                WHERE state = 'active'
                AND (startedOn + expireAfter) > now()
            `;

            let db = new Db(self.config);

            return db.executeSql(timeoutCommand)
                .catch(error => self.emit('error', error));
        }
    }

    registerJob(name, config, callback){

        assert(name, 'boss requires all jobs to have a name');

        config = config || {};
        assert(typeof config == 'object', 'expected config to be an object');

        config.teamSize = config.teamSize || 1;

        for(let w=0;w<config.teamSize; w++){

            let worker = new Worker(name, this.config);

            worker.on('error', error => this.emit('error', error));

            worker.on(name, job => {
                this.emit('job', {name, id: job.id});

                callback(job, () => this.closeJob(job.id));
            });

            this.workers.push(worker);
        }
    }

    submitJob(name, data){

        let now = new Date();

        let id = uuid.v4(),
            state = 'created',
            retryLimit = 0,
            startAfter = now,
            expireAfter = '5 minutes',
            createdOn = now;

        const newJobcommand = `
        INSERT INTO pdq.job (id, name, state, retryLimit, startAfter, expireAfter, createdOn, data)
        VALUES ($1, $2, $3, $4, $5, CAST($6 as interval), $7, $8)`;

        let values = [id, name, state, retryLimit, startAfter, expireAfter, createdOn, data];

        let db = new Db(this.config);

        return db.executeSql(newJobcommand, values)
            .then(() => id)
            .catch(error => this.emit('error', error));

    }

    closeJob(id){
        const closeJobCommand = `
            UPDATE pdq.job
            SET completedOn = $1
            WHERE id = $2`;

        let values = [new Date(), id];

        let db = new Db(this.config);

        return db.executeSql(closeJobCommand, values)
            .then(() => console.log(`completed job ${id}`))
            .catch(error => this.emit('error', error));
    }
}

module.exports = Manager;