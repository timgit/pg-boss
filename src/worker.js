class Worker {
    constructor(config){
        this.config = config;
    }
    
    start() {
        const self = this;
        
        checkForWork();

        // could this be replaced with this.start() instead of checkForWork()?

        function checkForWork(){
            if(self.stopped) return;

            self.config.fetcher()
                .then(self.config.responder)
                .catch(self.config.error)
                .then(() => setTimeout(checkForWork, self.config.interval));
        }
    }

    stop() {
        this.stopped = true;
    }
}

module.exports = Worker;