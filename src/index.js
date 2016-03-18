const EventEmitter = require('events');
const assert = require('assert');

const Attorney = require('./attorney');
const Contractor = require('./contractor');
const Manager = require('./manager');
const Boss = require('./boss');

class PgBoss extends EventEmitter {
    constructor(config){
        Attorney.checkConfig(config);

        super();

        this.config = config;

        // contractor makes sure we have a happy database home for work
        var contractor = new Contractor(config);
        this.contractor = contractor;

        contractor.on('error', error => this.emit('error', error));

        contractor.on('go', () => {
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

            this.isReady = true;
            this.emit('ready');
        });
    }

    start() {
        this.contractor.start();
    }

    connect() {
        this.contractor.connect();
    }

    subscribe(name, config, callback){
        assert(this.isReady, "boss ain't ready.  Use start() or connect() to get started.");
        return this.manager.subscribe(name, config, callback);
    }

    publish(name, data, options){
        assert(this.isReady, "boss ain't ready.  Use start() or connect() to get started.");
        return this.manager.publish(name, data, options);
    }
}

module.exports = PgBoss;
