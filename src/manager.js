const assert = require('assert');
const EventEmitter = require('events');
const Db = require('./db');
const uuid = require('node-uuid');
const Worker = require('./worker');

const nextJobCommand = `
  WITH nextJob as (
      SELECT id
      FROM pgboss.job
      WHERE (state = 'created' OR (state = 'expired' AND retryCount <= retryLimit))
        AND name = $1
        AND (createdOn + startIn) < now()
        AND completedOn IS NULL
      ORDER BY createdOn, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE pgboss.job SET
      state = 'active',
      startedOn = now(),
      retryCount = CASE WHEN state = 'expired' THEN retryCount + 1 ELSE retryCount END
    FROM nextJob
    WHERE pgboss.job.id = nextJob.id
    RETURNING pgboss.job.id, pgboss.job.data
`;

class Manager extends EventEmitter {
    constructor(config){
        super();

        config = config || {};

        config.uuid = config.uuid || 'v1';
        assert(config.uuid == 'v1' || config.uuid == 'v4', "uuid option only supports v1 or v4");

        this.workerInterval = (config.newJobCheckIntervalSeconds || 1) * 1000;

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
                UPDATE pgboss.job
                SET state = 'expired',
                    expiredOn = now()
                WHERE state = 'active'
                AND (startedOn + expireIn) > now()
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

        let db = new Db(this.config);

        let jobFetcher = () =>
            db.executeSql(nextJobCommand, name)
                .then(result => result.rows.length ? result.rows[0] : null);

        let workerConfig = {name: name, fetcher: jobFetcher, interval: this.workerInterval};

        for(let w=0;w<config.teamSize; w++){

            let worker = new Worker(workerConfig);

            worker.on('error', error => this.emit('error', error));

            worker.on(name, job => {
                this.emit('job', {name, id: job.id});

                callback(job, () => this.closeJob(job.id));
            });

            this.workers.push(worker);
        }
    }

    submitJob(name, data, options){

        options = options || {};

        // convert numeric to seconds
        options.startIn =
            (options.startIn > 0) ? options.startIn = '' + options.startIn
            : (typeof options.startIn == 'string') ? options.startIn
            : '0';

        let id = uuid[this.config.uuid](),
            state = 'created',
            retryLimit = options.retryLimit || 0,
            startIn = options.startIn || '0',
            expireIn = options.expireIn || '15 minutes';

        const newJobcommand = `
            INSERT INTO pgboss.job (id, name, state, retryLimit, startIn, expireIn, data)
            VALUES ($1, $2, $3, $4, CAST($5 as interval), CAST($6 as interval), $7)`;

        let values = [id, name, state, retryLimit, startIn, expireIn, data];

        let db = new Db(this.config);

        return db.executeSql(newJobcommand, values)
            .then(() => id)
            .catch(error => this.emit('error', error));

    }

    closeJob(id){
        const closeJobCommand = `
            UPDATE pgboss.job
            SET completedOn = now(),
                state = 'complete'
            WHERE id = $1`;

        let values = [id];

        let db = new Db(this.config);

        return db.executeSql(closeJobCommand, values)
            .catch(error => this.emit('error', error));
    }
}

module.exports = Manager;