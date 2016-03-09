const EventEmitter = require('events');
const assert = require('assert');
const Contractor = require('./contractor');
const Worker = require('./worker');
const Manager = require('./manager');
const Boss = require('./boss');

class PgBoss extends EventEmitter {
    constructor(config){
        super();

        assert(config && (typeof config == 'object' || typeof config == 'string'),
            'string or config object is required to connect to postgres');

        if(typeof config == 'object'){
            assert(config.database && config.user && 'password' in config,
                'expected configuration object to have enough information to connect to PostgreSQL');

            config.host = config.host || 'localhost';
            config.port = config.port || 5432;
        }

        this.config = config;
        this.workers = [];

        // contractor makes sure we have a happy database home for work
        Contractor.checkEnvironment(config)
            .then(() => {

                console.log('environment set up');

                // boss keeps the books and archives old jobs
                var boss = new Boss(config);
                boss.supervise();

                // manager makes sure workers aren't taking too long to finish their jobs
                var manager = new Manager(config);
                manager.monitor();
                manager.on('error', error => this.emit('error', error));

                this.manager = manager;

                this.emit('ready');
            })
            .catch(error => {
                this.emit('error', error);
            });

    }

    registerJob(name, config, callback){

        assert(name, 'boss requires all jobs to have a name');

        config = config || {};
        assert(typeof config == 'object', 'expected config to be an object');

        config.teamSize = config.teamSize || 1;

        for(let w=0;w<config.teamSize; w++){

            let worker = new Worker(name, this.config);

            worker.on('error', error => this.emit('error', error));

            worker.on(name, job => {
                this.emit('job', {name, id: job.id});

                callback(job, () => this.manager.closeJob(job.id));
            });

            this.workers.push(worker);
        }
    }

    submitJob(name, data, config){
        //TODO: enhance with Job param
        return this.manager.submitJob(name, data, config);
    }

}

module.exports = PgBoss;
