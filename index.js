const EventEmitter = require('events');
const assert = require('assert');
const Contractor = require('./contractor');
const Worker = require('./worker');
const Manager = require('./manager');
const Boss = require('./boss');

class PgBoss extends EventEmitter {
    constructor(config){
        assert(config && (typeof config == 'object' || typeof config == 'string'),
            'string or config object is required to connect to postgres');

        if(typeof config == 'object'){
            assert(config.database && config.user && 'password' in config,
                'expected configuration object to have enough information to connect to PostgreSQL');

            config.host = config.host || 'localhost';
            config.port = config.port || 5432;
        }

        this.config = config;

        // contractor makes sure we have a happy database home for work
        Contractor.checkEnvironment(config)
            .then(() => {

                // boss keeps the books and archives old jobs
                var boss = new Boss(config);
                boss.supervise();

                // manager makes sure workers aren't taking too long to finish their jobs
                var manager = new Manager(config);
                manager.monitor();

                this.workers = [];

                this.emit('ready');

            })
            .catch(error => this.emit('error', error));

    }

    registerJob(name, callback){
      this.worker.registerJob(name, callback);
    }

    submitJob(name, data, config){
        //TODO: enhance with Job param
        assert(name, 'boss requires all jobs to have a name');

        config = config || {};
        assert(typeof config == 'object', 'expected config to be an object');

        config.teamSize = config.teamSize || 1;

        for(let w=0;w<config.teamSize; w++){

            let worker = new Worker(config);
            worker.on('job', name => this.emit('job', name));
            worker.submitJob(name, data, config);

            this.workers.push(worker);
        }
    }

}

module.exports = PgBoss;
