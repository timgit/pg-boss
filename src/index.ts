import assert from 'assert'
import { EventEmitter } from 'events'
import * as Attorney from './attorney'
import { isDbConfig } from './attorney'
import Contractor from './contractor'
import Manager from './manager'
import Boss from './boss'
import Db from './db'
import * as plans from './plans'
import { BossConfig, DatabaseInterface } from './config'

const notReadyErrorMessage = 'boss ain\'t ready.  Use start() or connect() to get started.'
const alreadyStartedErrorMessage = 'boss.start() has already been called on this instance.'
const notStartedErrorMessage = 'boss ain\'t started.  Use start().'

class PgBoss extends EventEmitter {
  static getConstructionPlans (schema: string) {
    return Contractor.constructionPlans(schema)
  }

  static getMigrationPlans (schema: string, version: number) {
    return Contractor.migrationPlans(schema, version)
  }

  static getRollbackPlans (schema: string, version: number) {
    return Contractor.rollbackPlans(schema, version)
  }

  static readonly states = plans.states

  constructor (value: Parameters<typeof Attorney.getConfig>[0]) {
    super()

    const config = Attorney.getConfig(value)

    const db = getDb(config)

    if (db instanceof Db) { promoteEvent.call(this, db, 'error') }

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
    // TODO: fix on the second iteration.
    // The value is actually set, but the types don't line up.
    // Property 'schema' is optional in type 'DbSchemaConfig & DbConfig & QueueOptions & MaintenanceOptions & ExpirationOptions & RetentionOptions & RetryOptions & JobPollingOptions & Manager' but required in type 'MigrationConfig'
    // @ts-ignore
    this.contractor = new Contractor(db, config)
    this.manager = manager

    function getDb (config: BossConfig): DatabaseInterface {
      if (!isDbConfig(config)) {
        return config.db
      }

      return new Db(config)
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

  private isStarted = false
  private isReady = false
  private readonly config: BossConfig
  private readonly db: DatabaseInterface
  private readonly contractor: Contractor
  private readonly boss: Boss
  private readonly manager: Manager

  async start () {
    assert(!this.isStarted, alreadyStartedErrorMessage)
    this.isStarted = true

    if (this.db instanceof Db && !this.db.opened) {
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

    if (this.db instanceof Db) {
      await this.db.close()
    }

    this.isReady = false
    this.isStarted = false
  }

  async connect () {
    if (this.db instanceof Db && !this.db.opened) {
      await this.db.open()
    }

    await this.contractor.connect()
    this.isReady = true
    return this
  }

  async disconnect () {
    assert(this.isReady, notReadyErrorMessage)

    await this.manager.stop()

    if (this.db instanceof Db) {
      await this.db.close()
    }

    this.isReady = false
  }
}

export = PgBoss
