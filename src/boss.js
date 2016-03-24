const EventEmitter = require('events');
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

        archive();

        function archive(){
            let db = new Db(self.config);

            db.executeSql(self.archiveCommand, self.config.archiveCompletedJobsEvery)
                .catch(error => self.emit('error', error))
                .then(() => setTimeout(archive, self.superviseInterval));
        }
    }
}

module.exports = Boss;
