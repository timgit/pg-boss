const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;

class Worker extends EventEmitter {
    constructor(config){
        super();
        this.config = config;
    }
    
    start() {
        var self = this;
        
        checkForWork();

        function checkForWork(){
            if(!self.stopped)
                self.config.fetcher()
                    .then(job => { if(job) self.emit(self.config.name, job); })
                    .catch(error => self.emit('error', error))
                    .then(() => setTimeout(checkForWork, self.config.interval));
        }
    }

    stop() {
        this.stopped = true;
    }
}

module.exports = Worker;