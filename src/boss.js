const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;
const Db = require('./db');
const plans = require('./plans');

class Boss extends EventEmitter{
    constructor(config){
        super();

        this.config = config;
        this.superviseInterval = config.archiveCheckIntervalMinutes * 1000 * 60;
        this.archiveCommand = plans.archive(config.schema);
    }

    supervise(){
        var self = this;

        return archive();

        function archive(){
            let db = new Db(self.config);

            return db.executeSql(self.archiveCommand, self.config.archiveCompletedJobsEvery)
                .catch(error => self.emit('error', error))
                .then(() => setTimeout(archive, self.superviseInterval));
        }
    }
}

module.exports = Boss;
