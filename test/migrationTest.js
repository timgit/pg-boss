const assert = require('assert')
const PgBoss = require('../')
const helper = require('./testHelper')
const Contractor = require('../src/contractor')
const migrationStore = require('../src/migrationStore')
const currentSchemaVersion = require('../version.json').schema
const plans = require('../src/plans')

describe('migration', function () {
  beforeEach(async function () {
    const db = await helper.getDb({ debug: false })
    this.currentTest.contractor = new Contractor(db, this.currentTest.bossConfig)
  })

  it('should not migrate when current version is not found in migration store', async function () {
    const { contractor } = this.test
    const config = { ...this.test.bossConfig }

    await contractor.create()

    const db = await helper.getDb()
    // version 20 was v9 and dropped from the migration store with v10
    await db.executeSql(plans.setVersion(config.schema, 20))

    const boss = this.test.boss = new PgBoss(config)

    try {
      await boss.start()
      assert(false)
    } catch {
      assert(true)
    }
  })

  it.skip('should migrate to previous version and back again', async function () {
    const { contractor } = this.test

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oldVersion = await contractor.version()

    assert.notStrictEqual(oldVersion, currentSchemaVersion)

    await contractor.migrate(oldVersion)
    const newVersion = await contractor.version()

    assert.strictEqual(newVersion, currentSchemaVersion)
  })

  it.skip('should migrate to latest during start if on previous schema version', async function () {
    const { contractor } = this.test

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...this.test.bossConfig }

    const boss = this.test.boss = new PgBoss(config)

    await boss.start()

    const version = await contractor.version()

    assert.strictEqual(version, currentSchemaVersion)
  })

  it.skip('should migrate through 2 versions back and forth', async function () {
    const { contractor } = this.test

    const queue = 'migrate-back-2-and-forward'

    const config = { ...this.test.bossConfig }

    const boss = this.test.boss = new PgBoss(config)

    await boss.start()

    // creating jobs in 3 states to have data to migrate back and forth

    // completed job
    await boss.send(queue)
    const [job] = await boss.fetch(queue)
    await boss.complete(queue, job.id)

    // created job
    await boss.send(queue)

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

    await boss.send(queue)
    const [job2] = await boss.fetch(queue)
    await boss.complete(queue, job2.id)
  })

  it.skip('should migrate to latest during start if on previous 2 schema versions', async function () {
    const { contractor } = this.test

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()
    assert.strictEqual(oneVersionAgo, currentSchemaVersion - 1)

    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.version()
    assert.strictEqual(twoVersionsAgo, currentSchemaVersion - 2)

    const config = { ...this.test.bossConfig }
    const boss = this.test.boss = new PgBoss(config)
    await boss.start()

    const version = await contractor.version()

    assert.strictEqual(version, currentSchemaVersion)
  })

  it('migrating to non-existent version fails gracefully', async function () {
    const { contractor } = this.test

    await contractor.create()

    try {
      await contractor.migrate('¯\\_(ツ)_//¯')
    } catch (error) {
      assert(error.message.includes('not found'))
    }
  })

  it.skip('should roll back an error during a migration', async function () {
    const { contractor } = this.test

    const config = { ...this.test.bossConfig }

    config.migrations = migrationStore.getAll(config.schema)

    // add invalid sql statement
    config.migrations[0].install.push('wat')

    await contractor.create()
    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.version()

    const boss1 = new PgBoss(config)

    try {
      await boss1.start()
    } catch (error) {
      assert(error.message.includes('wat'))
    } finally {
      await boss1.stop({ graceful: false, wait: false })
    }

    const version1 = await contractor.version()

    assert.strictEqual(version1, oneVersionAgo)

    // remove bad sql statement
    config.migrations[0].install.pop()

    const boss2 = new PgBoss(config)

    await boss2.start()

    const version2 = await contractor.version()

    assert.strictEqual(version2, currentSchemaVersion)

    await boss2.stop({ graceful: false, wait: false })
  })

  it('should not install if migrate option is false', async function () {
    const config = { ...this.test.bossConfig, migrate: false }
    const boss = this.test.boss = new PgBoss(config)
    try {
      await boss.start()
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it.skip('should not migrate if migrate option is false', async function () {
    const { contractor } = this.test

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...this.test.bossConfig, migrate: false }
    const boss = this.test.boss = new PgBoss(config)

    try {
      await boss.start()
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should still work if migrate option is false', async function () {
    const { contractor } = this.test

    await contractor.create()

    const config = { ...this.test.bossConfig, migrate: false }
    const queue = this.test.bossConfig.schema

    const boss = this.test.boss = new PgBoss(config)

    try {
      await boss.start()
      await boss.send(queue)
      const [job] = await boss.fetch(queue)
      await boss.complete(queue, job.id)

      assert(false)
    } catch (err) {
      assert(true)
    }
  })
})
