const assert = require('assert')
const plans = require('./plans')
const migrationStore = require('./migrationStore')
const schemaVersion = require('../version.json').schema

class Contractor {
  static constructionPlans (schema) {
    const exportPlans = plans.create(schema)
    exportPlans.push(plans.insertVersion(schema).replace('$1', `'${schemaVersion}'`))

    return exportPlans.join(';\n\n')
  }

  static migrationPlans (schema, version, uninstall) {
    const migration = migrationStore.get(schema, version, uninstall)
    assert(migration, `migration not found from version ${version}. schema: ${schema}`)
    return migration.commands.join(';\n\n')
  }

  constructor (db, config) {
    this.config = config
    this.db = db
    this.migrations = this.config.migrations || migrationStore.getAll(this.config.schema)
  }

  async version () {
    const result = await this.db.executeSql(plans.getVersion(this.config.schema))
    return result.rows.length ? result.rows[0].version : null
  }

  async isCurrent () {
    const version = await this.version()
    return version === schemaVersion
  }

  async isInstalled () {
    const result = await this.db.executeSql(plans.versionTableExists(this.config.schema))
    return result.rows.length ? result.rows[0].name : null
  }

  async ensureCurrent () {
    const version = await this.version()

    if (schemaVersion !== version) {
      await this.update(version)
    }
  }

  async create () {
    // use transaction, in case one query fails, it will automatically rollback to avoid inconsistency
    const queryInTransaction = `
    BEGIN;     
    ${plans.create(this.config.schema).join(';')};
    ${plans.insertVersion(this.config.schema).replace('$1', `'${schemaVersion}'`)};
    COMMIT;`

    await this.db.executeSql(queryInTransaction)
  }

  async update (current) {
    if (current === '0.0.2') current = '0.0.1'

    const version = await this.migrate(current)

    if (version !== schemaVersion) {
      await this.update(version)
    }
  }

  async start () {
    try {
      await this.lock()

      const installed = await this.isInstalled()

      if (installed) {
        await this.ensureCurrent()
      } else {
        await this.create()
      }

      await this.unlock()
    } catch (err) {
      await this.unlock()
      throw err
    }
  }

  async lock () {
    await this.db.executeSql(plans.lock())
  }

  async unlock () {
    await this.db.executeSql(plans.unlock())
  }

  async connect () {
    const connectErrorMessage = 'this version of pg-boss does not appear to be installed in your database. I can create it for you via start().'

    const installed = await this.isInstalled()

    assert(installed, connectErrorMessage)

    const current = await this.isCurrent()

    assert(current, connectErrorMessage)
  }

  async migrate (version, uninstall) {
    const migration = migrationStore.get(this.config.schema, version, uninstall, this.migrations)

    assert(migration, `Migration to version ${version} failed because it could not be found.  Your database may have been upgraded by a newer version of pg-boss`)

    // use transaction, in case one query fails, it will automatically rollback to avoid inconsistency
    const queryInTransaction = `
    BEGIN;
    ${migration.commands.join(';')};
    COMMIT;`

    await this.db.executeSql(queryInTransaction)

    return migration.version
  }
}

module.exports = Contractor
