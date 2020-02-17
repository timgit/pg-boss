const assert = require('assert')
const plans = require('./plans')
const migrationStore = require('./migrationStore')
const schemaVersion = require('../version.json').schema

class Contractor {
  static constructionPlans (schema) {
    return plans.create(schema, schemaVersion)
  }

  static migrationPlans (schema, version) {
    return migrationStore.migrate(schema, version)
  }

  static rollbackPlans (schema, version) {
    return migrationStore.rollback(schema, version)
  }

  constructor (db, config) {
    this.config = config
    this.db = db
    this.migrations = this.config.migrations || migrationStore.getAll(this.config.schema)
  }

  async version () {
    const result = await this.db.executeSql(plans.getVersion(this.config.schema))
    return result.rows.length ? parseInt(result.rows[0].version) : null
  }

  async isCurrent () {
    const version = await this.version()
    return version === schemaVersion
  }

  async isInstalled () {
    const result = await this.db.executeSql(plans.versionTableExists(this.config.schema))
    return result.rows.length ? result.rows[0].name : null
  }

  async create () {
    try {
      const commands = plans.create(this.config.schema, schemaVersion)
      await this.db.executeSql(commands)
    } catch(err) {
      if(err.message.indexOf(plans.CREATE_RACE_MESSAGE) === -1) {
        throw(err)
      }
    }    
  }

  async start () {
    const installed = await this.isInstalled()
  
    if (installed) {
      const version = await this.version()
  
      if (schemaVersion !== version) {
        await this.migrate(version)
      }
    } else {
      await this.create()
    }      
  }

  async connect () {
    const installed = await this.isInstalled()
    assert(installed, `pg-boss is not installed in schema ${this.config.schema}. Running start() will automatically create it.`)

    const version = await this.version()
    assert((schemaVersion === version), `pg-boss database schema version ${version} is installed in this database, but this package expects v${schemaVersion}.`)
  }

  async migrate (version) {
    try {
      const commands = migrationStore.migrate(this.config.schema, version, this.migrations)
      await this.db.executeSql(commands)
    } catch(err) {
      if(err.message.indexOf(plans.MIGRATE_RACE_MESSAGE) === -1) {
        throw(err)
      }
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
