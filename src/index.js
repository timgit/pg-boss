const EventEmitter = require('events');
const Attorney = require('./attorney');
const Contractor = require('./contractor');
const Manager = require('./manager');
const Boss = require('./boss');
const Db = require('./db');
const plans = require('./plans');

const notReadyErrorMessage = `boss ain't ready.  Use start() or connect() to get started.`;
const alreadyStartedErrorMessage = 'boss.start() has already been called on this instance.';
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

    const db = getDb(config);

    if(db.isOurs)
      promoteEvent.call(this, db, 'error');

    const manager = new Manager(db, config);
    Object.keys(manager.events).forEach(event => promoteEvent.call(this, manager, manager.events[event]));
    manager.functions.forEach(func => promoteFunction.call(this, manager, func));

    const boss = new Boss(db, config);
    Object.keys(boss.events).forEach(event => promoteEvent.call(this, boss, boss.events[event]));

    this.config = config;
    this.db = db;
    this.boss = boss;
    this.contractor = new Contractor(db, config);
    this.manager = manager;

    function getDb(config){
      let db;

      if(config.db) {
        db = config.db;
      }
      else {
        db = new Db(config);
        db.isOurs = true;
      }

      return db;
    }

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

  start(options) {
    if(this.isStarted) return Promise.reject(alreadyStartedErrorMessage);

    options = options || {};

    this.isStarted = true;

    return this.contractor.start.call(this.contractor)
      .then(() => {
        this.isReady = true;

        if(!options.noSupervisor)
          this.boss.supervise(); // not in promise chain for async start()

        return this;
      });
  }

  stop() {
    if(!this.isStarted) return Promise.reject(notStartedErrorMessage);

    return Promise.all([
        this.manager.stop(),
        this.boss.stop()
      ])
      .then(() => this.db.isOurs ? this.db.close() : null)
      .then(() => {
        this.isReady = false;
        this.isStarted = false;
      });
  }

  connect() {
    return this.contractor.connect.call(this.contractor)
      .then(() => {
        this.isReady = true;
        return this;
      });
  }

  disconnect(...args) {
    if(!this.isReady) return Promise.reject(notReadyErrorMessage);

    return this.manager.stop.apply(this.manager, args)
      .then(() => this.db.isOurs ? this.db.close() : null)
      .then(() => this.isReady = false);
  }

}

module.exports = PgBoss;
module.exports.states = plans.states;
