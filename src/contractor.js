import assert from 'node:assert'
import version from '../version.json'
import {
  migrate as _migrate,
  next as _next,
  rollback as _rollback,
  getAll
} from './migrationStore.js'
import {
  create as _create,
  CREATE_RACE_MESSAGE,
  DEFAULT_SCHEMA,
  getVersion,
  MIGRATE_RACE_MESSAGE,
  versionTableExists
} from './plans.js'

const schemaVersion = version.schema

export default class Contractor {
  static constructionPlans (schema = DEFAULT_SCHEMA) {
    return _create(schema, schemaVersion)
  }

  static migrationPlans (schema = DEFAULT_SCHEMA, version = schemaVersion - 1) {
    return _migrate(schema, version)
  }

  static rollbackPlans (schema = DEFAULT_SCHEMA, version = schemaVersion) {
    return _rollback(schema, version)
  }

  constructor (db, config) {
    this.config = config
    this.db = db
    this.migrations = this.config.migrations || getAll(this.config.schema)

    // exported api to index
    this.functions = [this.schemaVersion, this.isInstalled]
  }

  async schemaVersion () {
    const result = await this.db.executeSql(getVersion(this.config.schema))
    return result.rows.length ? parseInt(result.rows[0].version, 10) : null
  }

  async isInstalled () {
    const result = await this.db.executeSql(
      versionTableExists(this.config.schema)
    )
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
      const commands = _create(this.config.schema, schemaVersion)
      await this.db.executeSql(commands)
    } catch (err) {
      assert(err.message.includes(CREATE_RACE_MESSAGE), err)
    }
  }

  async migrate (version) {
    try {
      const commands = _migrate(this.config, version, this.migrations)
      await this.db.executeSql(commands)
    } catch (err) {
      assert(err.message.includes(MIGRATE_RACE_MESSAGE), err)
    }
  }

  async next (version) {
    const commands = _next(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }

  async rollback (version) {
    const commands = _rollback(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }
}
