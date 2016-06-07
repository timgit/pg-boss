const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;
const Db = require('./db');
const plans = require('./plans');

class Boss extends EventEmitter{
    constructor(config){
        super();
        
        this.db = new Db(config);
        this.config = config;
        this.archiveCommand = plans.archive(config.schema);
    }

    supervise(){
        var self = this;

        return archive().then(init);
        
        function archive(){
            return self.db.executeSql(self.archiveCommand, self.config.archiveCompletedJobsEvery);
        }
        
        function init() {
            setTimeout(check, self.config.archiveCheckInterval);

            function check() {
                archive().catch(error => self.emit('error', error)).then(init)
            }
        }
    }
}

module.exports = Boss;
