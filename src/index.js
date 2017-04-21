const EventEmitter = require('events');
const assert = require('assert');
const Promise = require('bluebird');
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

    const manager = new Manager(db, config);
    Object.keys(manager.events).forEach(event => promoteEvent.call(this, manager, manager.events[event]));

    manager.functions.forEach(func => promoteFunction.call(this, manager, func));

    const boss = new Boss(db, config);
    Object.keys(boss.events).forEach(event => promoteEvent.call(this, boss, boss.events[event]));
    boss.on(boss.events.expiredJob, job => manager.expired(job));

    this.config = config;
    this.db = db;
    this.boss = boss;
    this.contractor = new Contractor(db, config);
    this.manager = manager;


    function promoteFunction(obj, func){
      this[func.name] = (...args) => {
        if(!this.isReady) return Promise.reject(notReadyErrorMessage);
        return func.apply(obj, args);
      }
    }

    function promoteEvent(emitter, event){
      emitter.on(event, arg => this.emit(event, arg));
    }

  }

  init() {
    if(this.isReady) return Promise.resolve(this);

    return this.boss.supervise()
      .then(() => {
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

    return this.manager.stop.apply(this.manager, args)
      .then(() => this.db.close())
      .then(() => this.isReady = false);
  }

}

module.exports = PgBoss;
