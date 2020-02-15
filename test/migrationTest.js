const assert = require('chai').assert
const PgBoss = require('../src/index')
const helper = require('./testHelper')
const Contractor = require('../src/contractor')
const migrationStore = require('../src/migrationStore')
const currentSchemaVersion = require('../version.json').schema

describe('migration', function () {
  this.timeout(10000)

  let contractor

  beforeEach(async function () {
    await helper.init()
    const db = await helper.getDb()
    contractor = new Contractor(db, helper.getConfig())
  })

  it('should migrate to previous version and back again', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oldVersion = await contractor.version()

    assert.notEqual(oldVersion, currentSchemaVersion)

    await contractor.migrate(oldVersion)
    const newVersion = await contractor.version()

    assert.equal(newVersion, currentSchemaVersion)
  })

  it('should migrate to latest during start if on previous schema version', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    await new PgBoss(helper.getConfig()).start({ noSupervisor: true })

    const version = await contractor.version()

    assert.equal(version, currentSchemaVersion)
  })

  it('should migrate through 2 versions back and forth', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()

    assert.notEqual(oneVersionAgo, currentSchemaVersion)

    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.version()

    assert.notEqual(twoVersionsAgo, oneVersionAgo)

    await contractor.next(twoVersionsAgo)
    const oneVersionAgoPart2 = await contractor.version()

    assert.equal(oneVersionAgo, oneVersionAgoPart2)

    await contractor.next(oneVersionAgo)
    const version = await contractor.version()

    assert.equal(version, currentSchemaVersion)
  })

  it('should migrate to latest during start if on previous 2 schema versions', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()

    await contractor.rollback(oneVersionAgo)

    const boss = new PgBoss(helper.getConfig())

    await boss.start({ noSupervisor: true })

    const version = await contractor.version()

    assert.equal(version, currentSchemaVersion)
  })

  it('migrating to non-existent version fails gracefully', async function () {
    await contractor.create()

    try {
      await contractor.migrate('¯\\_(ツ)_//¯')
    } catch (error) {
      assert(error.message.indexOf('not found') > -1)
    }
  })

  it('should roll back an error during a migration', async function () {
    const config = helper.getConfig()

    config.migrations = migrationStore.getAll(config.schema)

    // add invalid sql statement
    config.migrations[config.migrations.length - 1].install.push('wat')

    await contractor.create()
    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()

    try {
      await new PgBoss(config).start({ noSupervisor: true })
    } catch (error) {
      assert(error.message.indexOf('wat') > 0)
    }

    const version1 = await contractor.version()

    assert.equal(version1, oneVersionAgo)

    // remove bad sql statement
    config.migrations[config.migrations.length - 1].install.pop()

    const boss = new PgBoss(config)

    await boss.start({ noSupervisor: true })

    const version2 = await contractor.version()

    assert.equal(version2, currentSchemaVersion)
  })
})
