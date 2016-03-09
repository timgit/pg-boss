const EventEmitter = require('events');
const Db = require('./db');
const uuid = require('node-uuid');

class Manager extends EventEmitter {
    constructor(config){
        super();

        this.config = config;
        this.monitorInterval = 1000 * 60;
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