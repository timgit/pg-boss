const EventEmitter = require('node:events')
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
  #stoppingOn
  #stopped
  #starting
  #started
  #config
  #db
  #boss
  #contractor
  #manager
  #timekeeper

  static getConstructionPlans (schema) {
    return Contractor.constructionPlans(schema)
  }

  static getMigrationPlans (schema, version) {
    return Contractor.migrationPlans(schema, version)
  }

  static getRollbackPlans (schema, version) {
    return Contractor.rollbackPlans(schema, version)
  }

  static states = plans.JOB_STATES
  static policies = plans.QUEUE_POLICIES

  constructor (value) {
    super()

    this.#stoppingOn = null
    this.#stopped = true

    const config = Attorney.getConfig(value)
    this.#config = config

    const db = this.getDb()
    this.#db = db

    if (db.isOurs) {
      this.#promoteEvents(db)
    }

    const contractor = new Contractor(db, config)

    const manager = new Manager(db, config)
    const bossConfig = { ...config, manager }

    const boss = new Boss(db, bossConfig)

    const timekeeper = new Timekeeper(db, bossConfig)
    manager.timekeeper = timekeeper

    this.#promoteEvents(manager)
    this.#promoteEvents(boss)
    this.#promoteEvents(timekeeper)

    this.#promoteFunctions(boss)
    this.#promoteFunctions(contractor)
    this.#promoteFunctions(manager)
    this.#promoteFunctions(timekeeper)

    this.#boss = boss
    this.#contractor = contractor
    this.#manager = manager
    this.#timekeeper = timekeeper
  }

  getDb () {
    if (this.#db) {
      return this.#db
    }

    if (this.#config.db) {
      return this.#config.db
    }

    const db = new Db(this.#config)
    db.isOurs = true
    return db
  }

  #promoteEvents (emitter) {
    for (const event of Object.values(emitter?.events)) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  #promoteFunctions (obj) {
    for (const func of obj?.functions) {
      this[func.name] = (...args) => func.apply(obj, args)
    }
  }

  async start () {
    if (this.#starting || this.#started) {
      return this
    }

    this.#starting = true

    if (this.#db.isOurs && !this.#db.opened) {
      await this.#db.open()
    }

    if (this.#config.migrate) {
      await this.#contractor.start()
    } else {
      await this.#contractor.check()
    }

    this.#manager.start()

    if (this.#config.supervise) {
      await this.#boss.supervise()
    }

    if (this.#config.monitorStateIntervalSeconds) {
      await this.#boss.monitor()
    }

    if (this.#config.schedule) {
      await this.#timekeeper.start()
    }

    this.#starting = false
    this.#started = true
    this.#stopped = false

    return this
  }

  async stop (options = {}) {
    if (this.#stoppingOn || this.#stopped) {
      return
    }

    let { close = true, graceful = true, timeout = 30000, wait = true } = options

    timeout = Math.max(timeout, 1000)

    this.#stoppingOn = Date.now()

    await this.#manager.stop()
    await this.#timekeeper.stop()
    await this.#boss.stop()

    await new Promise((resolve, reject) => {
      const shutdown = async () => {
        try {
          if (this.#config.__test__throw_shutdown) {
            throw new Error(this.#config.__test__throw_shutdown)
          }

          await this.#manager.failWip()

          if (this.#db.isOurs && this.#db.opened && close) {
            await this.#db.close()
          }

          this.#stopped = true
          this.#stoppingOn = null
          this.#started = false

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
          if (this.#config.__test__throw_stop_monitor) {
            throw new Error(this.#config.__test__throw_stop_monitor)
          }

          const isWip = () => this.#manager.getWipData({ includeInternal: false }).length > 0

          while ((Date.now() - this.#stoppingOn) < timeout && isWip()) {
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
