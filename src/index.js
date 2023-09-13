const EventEmitter = require('events')
const plans = require('./plans')
const Attorney = require('./attorney')
const Contractor = require('./contractor')
const Manager = require('./manager')
const Timekeeper = require('./timekeeper')
const Boss = require('./boss')
const Db = require('./db')
const { delay } = require('./tools')

const events = {
  error: 'error',
  stopped: 'stopped'
}
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

    this.stoppingOn = null
    this.stopped = true
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
      this[func.name] = (...args) => func.apply(obj, args)
    }

    function promoteEvent (emitter, event) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  async start () {
    if (this.starting || this.started) {
      return
    }

    this.starting = true

    if (this.db.isOurs && !this.db.opened) {
      await this.db.open()
    }

    if (this.config.migrate) {
      await this.contractor.start()
    } else {
      await this.contractor.check()
    }

    this.manager.start()

    if (this.config.supervise) {
      await this.boss.supervise()
    }

    if (this.config.monitorStateIntervalSeconds) {
      await this.boss.monitor()
    }

    if (this.config.schedule) {
      await this.timekeeper.start()
    }

    this.starting = false
    this.started = true
    this.stopped = false

    return this
  }

  async stop (options = {}) {
    if (this.stoppingOn || this.stopped) {
      return
    }

    let { destroy = false, graceful = true, timeout = 30000, wait = true } = options

    timeout = Math.max(timeout, 1000)

    this.stoppingOn = Date.now()

    await this.manager.stop()
    await this.timekeeper.stop()
    await this.boss.stop()

    await new Promise((resolve, reject) => {
      const shutdown = async () => {
        try {
          if (this.config.__test__throw_shutdown) {
            throw new Error(this.config.__test__throw_shutdown)
          }

          await this.manager.failWip()

          if (this.db.isOurs && this.db.opened && destroy) {
            await this.db.close()
          }

          this.stopped = true
          this.stoppingOn = null
          this.started = false

          this.emit(events.stopped)
          resolve()
        } catch (err) {
          this.emit(events.error, err)
          reject(err)
        }
      }

      if (!graceful) {
        return shutdown()
      }

      if (!wait) {
        resolve()
      }

      setImmediate(async () => {
        try {
          if (this.config.__test__throw_stop_monitor) {
            throw new Error(this.config.__test__throw_stop_monitor)
          }

          const isWip = () => this.manager.getWipData({ includeInternal: false }).length > 0

          while ((Date.now() - this.stoppingOn) < timeout && isWip()) {
            await delay(500)
          }

          await shutdown()
        } catch (err) {
          reject(err)
          this.emit(events.error, err)
        }
      })
    })
  }
}

module.exports = PgBoss
module.exports.states = plans.states
