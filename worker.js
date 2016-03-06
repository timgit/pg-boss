const EventEmitter = require('events');
const Db = require('./db');
const uuid = require('node-uuid');

const nextJobCommand = `
  WITH nextJob as (
      SELECT id FROM pdq.job
      WHERE (state = 'created' OR (state = 'timeout' AND retryCount <= retryLimit))
        AND name = ANY($1)
        AND startAfter < now()
      ORDER BY createdOn
      LIMIT 1
      FOR UPDATE
    )
    UPDATE pdq.job SET
      state = 'active',
      startedOn = now(),
      retryCount = CASE WHEN state = 'timeout' THEN retryCount + 1 ELSE retryCount END
    WHERE id = nextJob.id
`;

class Worker extends EventEmitter {
    constructor(config){
        this.config = config;
        this.interval = 1000;
        this.jobRegistry = [];

        return clockIn(this);


        function clockIn(self){

            return setInterval(checkForWork, self.interval);

            function checkForWork() {
                if(self.jobRegistry.length === 0)
                    return;

                let db = new Db(self.config);

                return db.executeSql(nextJobCommand, [self.jobRegistry])
                    .then(job => {
                        if(job)
                            self.emit(job.name, job.data);
                    });
            }
        }
    }

  registerJob(name, callback) {
    this.on(name, callback);
    this.jobRegistry.push(name);
  }

  submitJob(name, data){

    let now = new Date();
    let fiveMinutes = (1000 * 60 * 5);

    let id = uuid.v4(),
        state = 'created',
        retryLimit = 0,
        startAfter = now,
        expireAfter = new Date(now.getTime() + fiveMinutes),
        createdOn = now;

    const newJobcommand = `
        INSERT INTO pdq.job (id, name, state, retryLimit, startAfter, expireAfter, createdOn, data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

    let values = [id, name, state, retryLimit, startAfter, expireAfter, createdOn, data];

    return db.executeSql(newJobcommand, values)
        .then(() => id)
        .catch(error => this.emit('error', error));

  }

}

module.exports = Worker;