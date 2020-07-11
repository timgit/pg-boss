const EventEmitter = require('events')
const plans = require('./plans')
const Attorney = require('./attorney')
const Contractor = require('./contractor')
const Manager = require('./manager')
const Timekeeper = require('./timekeeper')
const Boss = require('./boss')
const Db = require('./db')

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

    if (db.isOurs) {
      promoteEvent.call(this, db, 'error')
    }

    const manager = new Manager(db, config)
    Object.keys(manager.events).forEach(event => promoteEvent.call(this, manager, manager.events[event]))
    manager.functions.forEach(func => promoteFunction.call(this, manager, func))

    const bossConfig = { ...config, manager }

    const boss = new Boss(db, bossConfig)
    Object.keys(boss.events).forEach(event => promoteEvent.call(this, boss, boss.events[event]))
    boss.functions.forEach(func => promoteFunction.call(this, boss, func))

    const timekeeper = new Timekeeper(db, bossConfig)
    Object.keys(timekeeper.events).forEach(event => promoteEvent.call(this, timekeeper, timekeeper.events[event]))
    timekeeper.functions.forEach(func => promoteFunction.call(this, timekeeper, func))

    manager.timekeeper = timekeeper

    this.config = config
    this.db = db
    this.boss = boss
    this.contractor = new Contractor(db, config)
    this.manager = manager
    this.timekeeper = timekeeper

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
        if (!this.isStarted) {
          return Promise.reject(new Error('pg-boss not started! Use start().'))
        }

        return func.apply(obj, args)
      }
    }

    function promoteEvent (emitter, event) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  async start () {
    if (this.isStarted) {
      return this
    }

    if (this.db.isOurs && !this.db.opened) {
      await this.db.open()
    }

    await this.contractor.start()

    if (!this.config.noSupervisor) {
      await this.boss.supervise()
    }

    if (!this.config.noScheduling) {
      await this.timekeeper.start()
    }

    this.isStarted = true

    return this
  }

  async stop () {
    if (!this.isStarted) {
      return
    }

    await this.timekeeper.stop()
    await this.manager.stop()
    await this.boss.stop()

    if (this.db.isOurs) {
      await this.db.close()
    }

    this.isStarted = false
  }
}

module.exports = PgBoss
module.exports.states = plans.states
