const assert = require('assert')
const PgBoss = require('../')
const helper = require('./testHelper')
const Contractor = require('../src/contractor')
const migrationStore = require('../src/migrationStore')
const currentSchemaVersion = require('../version.json').schema

describe('migration', function () {
  let contractor

  beforeEach(async function () {
    const db = await helper.getDb()
    contractor = new Contractor(db, this.currentTest.bossConfig)
  })

  it('should migrate to previous version and back again', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oldVersion = await contractor.version()

    assert.notStrictEqual(oldVersion, currentSchemaVersion)

    await contractor.migrate(oldVersion)
    const newVersion = await contractor.version()

    assert.strictEqual(newVersion, currentSchemaVersion)
  })

  it('should migrate to latest during start if on previous schema version', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...this.test.bossConfig, noSupervisor: true }

    const boss = new PgBoss(config)

    await boss.start()

    const version = await contractor.version()

    assert.strictEqual(version, currentSchemaVersion)

    await boss.stop()
  })

  it('should migrate through 2 versions back and forth', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()

    assert.notStrictEqual(oneVersionAgo, currentSchemaVersion)

    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.version()

    assert.notStrictEqual(twoVersionsAgo, oneVersionAgo)

    await contractor.next(twoVersionsAgo)
    const oneVersionAgoPart2 = await contractor.version()

    assert.strictEqual(oneVersionAgo, oneVersionAgoPart2)

    await contractor.next(oneVersionAgo)
    const version = await contractor.version()

    assert.strictEqual(version, currentSchemaVersion)
  })

  it('should migrate to latest during start if on previous 2 schema versions', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()
    assert.strictEqual(oneVersionAgo, currentSchemaVersion - 1)

    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.version()
    assert.strictEqual(twoVersionsAgo, currentSchemaVersion - 2)

    const config = { ...this.test.bossConfig, noSupervisor: true }
    const boss = new PgBoss(config)
    await boss.start()

    const version = await contractor.version()

    assert.strictEqual(version, currentSchemaVersion)

    await boss.stop()
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
    const config = this.test.bossConfig

    config.migrations = migrationStore.getAll(config.schema)

    // add invalid sql statement
    config.migrations[0].install.push('wat')

    await contractor.create()
    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()

    try {
      await new PgBoss(config).start({ noSupervisor: true })
    } catch (error) {
      assert(error.message.indexOf('wat') > 0)
    }

    const version1 = await contractor.version()

    assert.strictEqual(version1, oneVersionAgo)

    // remove bad sql statement
    config.migrations[0].install.pop()

    const boss = new PgBoss(config)

    await boss.start({ noSupervisor: true })

    const version2 = await contractor.version()

    assert.strictEqual(version2, currentSchemaVersion)

    await boss.stop()
  })
})
