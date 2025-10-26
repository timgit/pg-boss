import assert from 'node:assert'
import * as plans from './plans.js'
import * as migrationStore from './migrationStore.js'
import versionMod from '../version.json' with { type: 'json' }
import type * as types from './types.js'

const schemaVersion = versionMod.schema

class Contractor {
  static constructionPlans (schema = plans.DEFAULT_SCHEMA) {
    return plans.create(schema, schemaVersion)
  }

  static migrationPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion - 1) {
    return migrationStore.migrate(schema, version)
  }

  static rollbackPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion) {
    return migrationStore.rollback(schema, version)
  }

  private config: types.ResolvedConstructorOptions
  private db: types.IDatabase
  private migrations: types.Migration[]

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    this.config = config
    this.db = db
    this.migrations = this.config.migrations || migrationStore.getAll(this.config.schema)
  }

  async schemaVersion () {
    const result = await this.db.executeSql(plans.getVersion(this.config.schema))
    return result.rows.length ? parseInt(result.rows[0].version) : null
  }

  async isInstalled () {
    const result = await this.db.executeSql(plans.versionTableExists(this.config.schema))
    return !!result.rows[0].name
  }

  async start () {
    const installed = await this.isInstalled()

    if (installed) {
      const version = await this.schemaVersion()

      if (version === null || schemaVersion > version) {
        await this.migrate(version)
      }
    } else {
      await this.create()
    }
  }

  async check () {
    const installed = await this.isInstalled()

    if (!installed) {
      throw new Error('pg-boss is not installed')
    }

    const version = await this.schemaVersion()

    if (schemaVersion !== version) {
      throw new Error('pg-boss database requires migrations')
    }
  }

  async create () {
    try {
      const commands = plans.create(this.config.schema, schemaVersion)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.CREATE_RACE_MESSAGE), err)
    }
  }

  async migrate (version: number | null) {
    try {
      const commands = migrationStore.migrate(this.config.schema, version, this.migrations)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.MIGRATE_RACE_MESSAGE), err)
    }
  }

  async next (version: number | null) {
    const commands = migrationStore.next(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }

  async rollback (version: number | null) {
    const commands = migrationStore.rollback(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }
}

export default Contractor
