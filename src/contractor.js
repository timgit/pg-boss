const assert = require('node:assert')
const plans = require('./plans')
const { DEFAULT_SCHEMA } = plans
const migrationStore = require('./migrationStore')
const schemaVersion = require('../version.json').schema

class Contractor {
  static constructionPlans (schema = DEFAULT_SCHEMA) {
    return plans.create(schema, schemaVersion)
  }

  static migrationPlans (schema = DEFAULT_SCHEMA, version = schemaVersion - 1) {
    return migrationStore.migrate(schema, version)
  }

  static rollbackPlans (schema = DEFAULT_SCHEMA, version = schemaVersion) {
    return migrationStore.rollback(schema, version)
  }

  constructor (db, config) {
    this.config = config
    this.db = db
    this.migrations = this.config.migrations || migrationStore.getAll(this.config.schema)

    // exported api to index
    this.functions = [
      this.schemaVersion,
      this.isInstalled
    ]
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

      if (schemaVersion > version) {
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
    } catch (err) {
      assert(err.message.includes(plans.CREATE_RACE_MESSAGE), err)
    }
  }

  async migrate (version) {
    try {
      const commands = migrationStore.migrate(this.config, version, this.migrations)
      await this.db.executeSql(commands)
    } catch (err) {
      assert(err.message.includes(plans.MIGRATE_RACE_MESSAGE), err)
    }
  }

  async next (version) {
    const commands = migrationStore.next(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }

  async rollback (version) {
    const commands = migrationStore.rollback(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }
}

module.exports = Contractor
