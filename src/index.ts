const assert = require('assert')
const EventEmitter = require('events')
const Attorney = require('./attorney')
const Contractor = require('./contractor')
const Manager = require('./manager')
const Boss = require('./boss')
const Db = require('./db')
const plans = require('./plans')

const notReadyErrorMessage = 'boss ain\'t ready.  Use start() or connect() to get started.'
const alreadyStartedErrorMessage = 'boss.start() has already been called on this instance.'
const notStartedErrorMessage = 'boss ain\'t started.  Use start().'

class PgBoss extends EventEmitter {
  static getConstructionPlans (schema) {
    return Contractor.constructionPlans(schema)
  }

  static getMigrationPlans (schema, version) {
    return Contractor.migrationPlans(schema, version)
  }

  static getRollbackPlans (schema, version) {
    return Contractor.rollbackPlans(schema, version)
  }

  constructor (value) {
    const config = Attorney.getConfig(value)

    super()

    const db = getDb(config)

    if (db.isOurs) { promoteEvent.call(this, db, 'error') }

    const manager = new Manager(db, config)
    Object.keys(manager.events).forEach(event => promoteEvent.call(this, manager, manager.events[event]))
    manager.functions.forEach(func => promoteFunction.call(this, manager, func))

    const bossConfig = { ...config, manager }

    const boss = new Boss(db, bossConfig)
    Object.keys(boss.events).forEach(event => promoteEvent.call(this, boss, boss.events[event]))
    boss.functions.forEach(func => promoteFunction.call(this, boss, func))

    this.config = config
    this.db = db
    this.boss = boss
    this.contractor = new Contractor(db, config)
    this.manager = manager

    function getDb (config) {
      if (config.db) {
        return config.db
      }

      const db = new Db(config)
      db.isOurs = true
      return db
    }

    function promoteFunction (obj, func) {
      this[func.name] = (...args) => {
        if (!this.isReady) return Promise.reject(notReadyErrorMessage)
        return func.apply(obj, args)
      }
    }

    function promoteEvent (emitter, event) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  async start () {
    assert(!this.isStarted, alreadyStartedErrorMessage)
    this.isStarted = true

    if (this.db.isOurs && !this.db.opened) {
      await this.db.open()
    }

    await this.contractor.start()

    this.isReady = true

    if (!this.config.noSupervisor) {
      await this.boss.supervise()
    }

    return this
  }

  async stop () {
    assert(this.isStarted, notStartedErrorMessage)

    await this.manager.stop()
    await this.boss.stop()

    if (this.db.isOurs) {
      await this.db.close()
    }

    this.isReady = false
    this.isStarted = false
  }

  async connect () {
    if (this.db.isOurs && !this.db.opened) {
      await this.db.open()
    }

    await this.contractor.connect()
    this.isReady = true
    return this
  }

  async disconnect () {
    assert(this.isReady, notReadyErrorMessage)

    await this.manager.stop()

    if (this.db.isOurs) {
      await this.db.close()
    }

    this.isReady = false
  }
}

module.exports = PgBoss
module.exports.states = plans.states
