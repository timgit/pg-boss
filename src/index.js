const EventEmitter = require('events');
const assert = require('assert');
const Promise = require("bluebird");
const Attorney = require('./attorney');
const Contractor = require('./contractor');
const Manager = require('./manager');
const Boss = require('./boss');
const Db = require('./db');

const notReadyErrorMessage = `boss ain't ready.  Use start() or connect() to get started.`;
const startInProgressErrorMessage = 'boss is starting up. Please wait for the previous start() to finish.';
const notStartedErrorMessage = `boss ain't started.  Use start().`;

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

    const db = new Db(config);

    promoteEvent.call(this, db, 'error');

    const boss = new Boss(db, config);
    boss.promotedEvents.forEach(event => promoteEvent.call(this, boss, event));

    const manager = new Manager(db, config);
    manager.promotedEvents.forEach(event => promoteEvent.call(this, manager, event));

    ['fetch','complete','cancel','fail','publish','subscribe','unsubscribe','onComplete','onExpire']
      .forEach(func => promoteApi.call(this, manager, func));

    this.config = config;
    this.db = db;
    this.boss = boss;
    this.contractor = new Contractor(db, config);
    this.manager = manager;


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

    return Promise.join(
      this.boss.supervise(),
      this.manager.monitor()
    ).then(() => {
        this.isReady = true;
        this.isStarted = true;
        return this;
    });
  }

  start(...args) {
    if(this.isStarting)
      return Promise.reject(startInProgressErrorMessage);

    this.isStarting = true;

    let check = this.isStarted
      ? Promise.resolve(true)
      : this.contractor.start.apply(this.contractor, args);

    return check.then(() => {
        this.isStarting = false;
        return this.init();
    });
  }

  stop() {
    if(!this.isStarted) return Promise.reject(notStartedErrorMessage);

    return Promise.join(
        this.manager.stop(),
        this.boss.stop()
      )
      .then(() => this.db.close())
      .then(() => {
        this.isReady = false;
        this.isStarted = false;
      });
  }

  connect(...args) {
    return this.contractor.connect.apply(this.contractor, args)
      .then(() => {
        this.isReady = true;
        return this;
      });
  }

  disconnect(...args) {
    if(!this.isReady) return Promise.reject(notReadyErrorMessage);

    return this.manager.close.apply(this.manager, args)
      .then(() => this.db.close())
      .then(() => this.isReady = false);
  }

}

module.exports = PgBoss;
