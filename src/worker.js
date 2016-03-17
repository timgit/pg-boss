const EventEmitter = require('events');
const Db = require('./db');

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
      FOR UPDATE
    )
    UPDATE pgboss.job SET
      state = 'active',
      startedOn = now(),
      retryCount = CASE WHEN state = 'expired' THEN retryCount + 1 ELSE retryCount END
    FROM nextJob
    WHERE pgboss.job.id = nextJob.id
    RETURNING pgboss.job.id, pgboss.job.data
`;

class Worker extends EventEmitter {
    constructor(name, config){
        super();

        const interval = config.interval || 1000;
        let db = new Db(config);

        this.checkForWork(this, name, db, interval);
    }

    checkForWork(worker, name, db, interval) {
        db.executeSql(nextJobCommand, name)
            .then(result => {
                if(result.rows.length)
                    worker.emit(name, result.rows[0]);
            })
            .catch(error => worker.emit('error', error))
            .then(() => setTimeout(worker.checkForWork, interval, worker, name, db, interval));
    }
}

module.exports = Worker;