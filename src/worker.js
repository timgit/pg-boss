const EventEmitter = require('events');
const Db = require('./db');

const nextJobCommand = `
  WITH nextJob as (
      SELECT id
      FROM pgboss.job
      WHERE (state = 'created' OR (state = 'expired' AND retryCount <= retryLimit))
        AND name = $1
        AND (createdOn + startIn) < now()
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

        var interval = 1000;

        clockIn(this);

        function clockIn(self){

            return setInterval(checkForWork, interval);

            function checkForWork() {
                let db = new Db(config);

                return db.executeSql(nextJobCommand, name)
                    .then(result => {
                        if(!result.rows.length)
                            return;

                        let job = result.rows[0];

                        self.emit(name, job);
                    })
                    .catch(error => self.emit('error', error));
            }
        }
    }

}

module.exports = Worker;