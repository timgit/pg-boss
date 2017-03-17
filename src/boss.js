const EventEmitter = require('events');
const plans = require('./plans');
const Promise = require("bluebird");

class Boss extends EventEmitter{
    constructor(db, config){
        super();

        this.db = db;
        this.config = config;
        this.archiveCommand = plans.archive(config.schema);
    }

    supervise(){
        const self = this;

        return archive().then(init);
        
        function archive(){
            return self.db.executeSql(self.archiveCommand, self.config.archiveCompletedJobsEvery)
                .then(result => {
                    if (result.rowCount)
                        self.emit('archived', result.rowCount);
                });
        }
        
        function init() {
            if(self.stopped) return;

            self.archiveTimer = setTimeout(check, self.config.archiveCheckInterval);

            function check() {
                archive().catch(error => self.emit('error', error)).then(init)
            }
        }
    }

    stop() {
        this.stopped = true;

        if(this.archiveTimer)
            clearTimeout(this.archiveTimer);

        return Promise.resolve();
    }
}

module.exports = Boss;
