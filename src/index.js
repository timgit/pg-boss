const EventEmitter = require('events');
const assert = require('assert');
const Promise = require("bluebird");
const Attorney = require('./attorney');
const Contractor = require('./contractor');
const Manager = require('./manager');
const Boss = require('./boss');
const Db = require('./db');

const notReadyErrorMessage = `boss ain't ready.  Use start() or connect() to get started.`;

class PgBoss extends EventEmitter {
  static getConstructionPlans(schema) {
    return Contractor.constructionPlans(schema);
  }

  static getMigrationPlans(schema, version, uninstall) {
    return Contractor.migrationPlans(schema, version, uninstall);
  }

  constructor(config){
    config = Attorney.applyConfig(config);

    super();

    this.config = config;

    const db = new Db(config);

    promoteEvent.call(this, db, 'error');

    // contractor makes sure we have a happy database home for work
    this.contractor = new Contractor(db, config);

    // boss keeps the books and archives old jobs
    let boss = new Boss(db, config);
    this.boss = boss;

    ['error','archived'].forEach(event => promoteEvent.call(this, boss, event));

    // manager makes sure workers aren't taking too long to finish their jobs
    let manager = new Manager(db, config);
    this.manager = manager;

    ['error','job','expired-job','expired-count','failed']
      .forEach(event => promoteEvent.call(this, manager, event));

    ['fetch','complete','cancel','fail','publish','subscribe','unsubscribe','onExpire']
      .forEach(func => promoteApi.call(this, manager, func));

    function promoteApi(obj, func){
      this[func] = (...args) => {
        if(!this.isReady) return Promise.reject(notReadyErrorMessage);
        return obj[func].apply(obj, args);
      }
    }

    function promoteEvent(emitter, event){
      emitter.on(event, arg => this.emit(event, arg));
    }

  }

  init() {
    if(this.isReady) return Promise.resolve(this);

    return this.boss.supervise()
      .then(() => this.manager.monitor())
      .then(() => {
        this.isReady = true;
        return this;
      });
  }

  start(...args) {
    let self = this;

    if(this.isStarting)
      return Promise.reject('boss is starting up. Please wait for the previous start() to finish.');

    this.isStarting = true;

    return this.contractor.start.apply(this.contractor, args)
      .then(() => {
        self.isStarting = false;
        return self.init();
      });
  }

  stop() {
    return Promise.all([
      this.disconnect(),
      this.manager.stop(),
      this.boss.stop()
    ]);
  }

  connect(...args) {
    let self = this;

    return this.contractor.connect.apply(this.contractor, args)
      .then(() => {
        self.isReady = true;
        return self;
      });
  }

  disconnect(...args) {
    if(!this.isReady) return Promise.reject(notReadyErrorMessage);
    return this.manager.close.apply(this.manager, args)
      .then(() => this.isReady = false);
  }

}

module.exports = PgBoss;
