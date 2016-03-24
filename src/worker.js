const EventEmitter = require('events');

class Worker extends EventEmitter {
    constructor(config){
        super();
        this.config = config;
    }
    
    start() {
        var self = this;
        
        checkForWork();

        function checkForWork(){
            self.config.fetcher()
                .then(job => { if(job) self.emit(self.config.name, job); })
                .catch(error => self.emit('error', error))
                .then(() => setTimeout(checkForWork, self.config.interval));
        }
    }
}

module.exports = Worker;