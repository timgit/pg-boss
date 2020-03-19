import assert from 'assert'
import * as plans from './plans'
import { SchemaName, SchemaVersion } from './plans'
import * as migrationStore from './migrationStore'
import { Migration, MigrationConfig } from './migrationStore'
import { schemaVersion } from './schemaVersion'
import Db from './db'

class Contractor {
  static constructionPlans(schema: SchemaName) {
    return plans.create(schema, schemaVersion)
  }

  static migrationPlans(schema: SchemaName, version: SchemaVersion) {
    return migrationStore.migrate(schema, version)
  }

  static rollbackPlans(schema: SchemaName, version: SchemaVersion) {
    return migrationStore.rollback(schema, version)
  }

  constructor(private db: Db, private config: MigrationConfig) {
    this.migrations = this.config.migrations || migrationStore.getAll(this.config.schema)
  }

  private migrations: Migration[]

  async version (): Promise<SchemaVersion | null> {
    const result = await this.db.executeSql(plans.getVersion(this.config.schema))
    return result.rows.length ? Number(result.rows[0].version) : null
  }

  async isInstalled (): Promise<string | null> {
    const result = await this.db.executeSql(plans.versionTableExists(this.config.schema))
    return result.rows.length ? result.rows[0].name : null
  }

  async start () {
    const installed = await this.isInstalled()

    if (installed) {
      const version = await this.version()

      if (schemaVersion > version) {
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

  async create () {
    try {
      const commands = plans.create(this.config.schema, schemaVersion)
      await this.db.executeSql(commands)
    } catch (err) {
      const e = err as Error
      assert(e.message.indexOf(plans.CREATE_RACE_MESSAGE) > -1, e)
    }
  }

  async migrate (version: SchemaVersion) {
    try {
      const commands = migrationStore.migrate(this.config, version, this.migrations)
      await this.db.executeSql(commands)
    } catch (err) {
      const e = err as Error
      assert(e.message.indexOf(plans.MIGRATE_RACE_MESSAGE) > -1, e)
    }
  }

  async next (version: SchemaVersion) {
    const commands = migrationStore.next(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }

  async rollback (version: SchemaVersion) {
    const commands = migrationStore.rollback(this.config.schema, version, this.migrations)
    await this.db.executeSql(commands)
  }
}

// TODO: export class directly when tests are rewritten & disable esModuleInterop
export = Contractor
