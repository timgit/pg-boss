const EventEmitter = require('events');
const assert = require('assert');
const Contractor = require('./contractor');
const Manager = require('./manager');
const Boss = require('./boss');

class PgBoss extends EventEmitter {
    constructor(config){
        assertConfig();

        super();

        this.config = config;

        // contractor makes sure we have a happy database home for work
        var contractor = new Contractor(config);
        contractor.on('error', error => this.emit('error', error));

        contractor.checkEnvironment()
            .then(() => {
                // boss keeps the books and archives old jobs
                var boss = new Boss(config);
                boss.on('error', error => this.emit('error', error));
                boss.supervise();

                // manager makes sure workers aren't taking too long to finish their jobs
                var manager = new Manager(config);
                manager.on('error', error => this.emit('error', error));
                manager.on('job', job => this.emit('job', job));
                manager.monitor();

                this.manager = manager;

                this.emit('ready');
            })
            .catch(error => {
                this.emit('error', error);
            });


        function assertConfig() {
            assert(config && (typeof config == 'object' || typeof config == 'string'),
                'string or config object is required to connect to postgres');

            if(typeof config == 'object'){
                assert(config.database && config.user && 'password' in config,
                    'expected configuration object to have enough information to connect to PostgreSQL');

                config.host = config.host || 'localhost';
                config.port = config.port || 5432;
            }
        }

    }

    registerJob(name, config, callback){
        return this.manager.registerJob(name, config, callback);
    }

    submitJob(name, data, options){
        //TODO: enhance with Job param
        return this.manager.submitJob(name, data, options);
    }
}

module.exports = PgBoss;
