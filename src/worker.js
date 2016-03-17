const EventEmitter = require('events');

class Worker extends EventEmitter {
    constructor(config){
        super();

        checkForWork(this);

        function checkForWork(worker){
            config.fetcher()
                .then(job => { if(job) worker.emit(config.name, job); })
                .catch(error => worker.emit('error', error))
                .then(() => setTimeout(checkForWork, config.interval, worker));
        }
    }
}

module.exports = Worker;