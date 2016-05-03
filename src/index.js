const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;
const assert = require('assert');

const Attorney = require('./attorney');
const Contractor = require('./contractor');
const Manager = require('./manager');
const Boss = require('./boss');

class PgBoss extends EventEmitter {
    static getConstructionPlans(schema) {
        return Contractor.constructionPlans(schema);
    }

    constructor(config){
        config = Attorney.checkConfig(config);

        super();

        this.config = config;

        // contractor makes sure we have a happy database home for work
        var contractor = new Contractor(config);
        contractor.on('error', error => this.emit('error', error));
        this.contractor = contractor;

        // boss keeps the books and archives old jobs
        var boss = new Boss(config);
        boss.on('error', error => this.emit('error', error));

        // manager makes sure workers aren't taking too long to finish their jobs
        var manager = new Manager(config);
        manager.on('error', error => this.emit('error', error));
        manager.on('job', job => this.emit('job', job));
        this.manager = manager;

        contractor.on('go', () => {
            if(!this.isReady){
                boss.supervise();
                manager.monitor();
            }

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

    subscribe(){
        assert(this.isReady, "boss ain't ready.  Use start() or connect() to get started.");
        return this.manager.subscribe.apply(this.manager, arguments);
    }

    publish(){
        assert(this.isReady, "boss ain't ready.  Use start() or connect() to get started.");
        return this.manager.publish.apply(this.manager, arguments);
    }
}

module.exports = PgBoss;
