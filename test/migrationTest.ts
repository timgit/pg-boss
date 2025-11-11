import assert from 'node:assert'
import { PgBoss, getConstructionPlans, getMigrationPlans, getRollbackPlans } from '../src/index.ts'
import { getDb } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import { getAll } from '../src/migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import { setVersion } from '../src/plans.ts'

const currentSchemaVersion = packageJson.pgboss.schema

describe('migration', function () {
  beforeEach(async function () {
    const db = await getDb({ debug: false })
    this.contractor = new Contractor(db, this.bossConfig)
  })

  it('should include create schema by default ', function () {
    const schema = 'custom'
    const plans = Contractor.constructionPlans(schema)
    assert(plans.includes('CREATE SCHEMA'))
  })

  it('should not include create schema if createSchema=false', function () {
    const schema = 'custom'
    const plans = Contractor.constructionPlans(schema, { createSchema: false })
    assert(!plans.includes('CREATE SCHEMA'))
  })

  it('should not install if createSchema option is false and schema is missing', async function () {
    const config = { ...this.bossConfig, createSchema: false }
    this.boss = new PgBoss(config)
    await assert.rejects(async () => {
      await this.boss.start()
    })
  })

  it('should export commands to manually build schema', function () {
    const schema = 'custom'
    const plans = getConstructionPlans(schema)

    assert(plans.includes(`${schema}.job`))
    assert(plans.includes(`${schema}.version`))
  })

  it('should fail to export migration using current version', function () {
    const schema = 'custom'

    assert.throws(() => {
      getMigrationPlans(schema, currentSchemaVersion)
    })
  })

  it('should export commands to migrate', function () {
    const schema = 'custom'
    const plans = getMigrationPlans(schema, currentSchemaVersion - 1)

    assert(plans)
  })

  it('should fail to export commands to roll back from invalid version', function () {
    const schema = 'custom'

    assert.throws(() => {
      getRollbackPlans(schema, -1)
    })
  })

  it('should export commands to roll back', function () {
    const schema = 'custom'
    const plans = getRollbackPlans(schema, currentSchemaVersion)

    assert(plans, 'rollback plans not found')
  })

  it('should not migrate when current version is not found in migration store', async function () {
    const { contractor } = this
    const config = { ...this.bossConfig }

    await contractor.create()

    const db = await getDb()
    // version 20 was v9 and dropped from the migration store with v10
    await db.executeSql(setVersion(config.schema, 20))

    this.boss = new PgBoss(config)

    await assert.rejects(async () => {
      await this.boss!.start()
    })
  })

  it.skip('should migrate to previous version and back again', async function () {
    const { contractor } = this

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oldVersion = await contractor.schemaVersion()

    assert.notStrictEqual(oldVersion, currentSchemaVersion)

    await contractor.migrate(oldVersion)
    const newVersion = await contractor.schemaVersion()

    assert.strictEqual(newVersion, currentSchemaVersion)
  })

  it('should install next version via contractor', async function () {
    const { contractor } = this

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const oneVersionAgo = await contractor.schemaVersion()

    await contractor.next(oneVersionAgo)

    const version = await contractor.schemaVersion()

    assert.strictEqual(version, currentSchemaVersion)
  })

  it('should migrate to latest during start if on previous schema version', async function () {
    const { contractor } = this

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...this.bossConfig }

    this.boss = new PgBoss(config)

    await this.boss.start()

    const version = await contractor.schemaVersion()

    assert.strictEqual(version, currentSchemaVersion)
  })

  it.skip('should migrate through 2 versions back and forth', async function () {
    const { contractor } = this

    const queue = 'migrate-back-2-and-forward'

    const config = { ...this.bossConfig }

    this.boss = new PgBoss(config)

    await this.boss.start()

    // creating jobs in 3 states to have data to migrate back and forth

    // completed job
    await this.boss.createQueue(queue)
    await this.boss.send(queue)
    const [job] = await this.boss.fetch(queue)
    await this.boss.complete(queue, job.id)

    // created job
    await this.boss.send(queue)

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()

    assert.notStrictEqual(oneVersionAgo, currentSchemaVersion)

    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.schemaVersion()

    assert.notStrictEqual(twoVersionsAgo, oneVersionAgo)

    await contractor.next(twoVersionsAgo)
    const oneVersionAgoPart2 = await contractor.schemaVersion()

    assert.strictEqual(oneVersionAgo, oneVersionAgoPart2)

    await contractor.next(oneVersionAgo)
    const version = await contractor.schemaVersion()

    assert.strictEqual(version, currentSchemaVersion)

    await this.boss.send(queue)
    const [job2] = await this.boss.fetch(queue)
    await this.boss.complete(queue, job2.id)
  })

  it.skip('should migrate to latest during start if on previous 2 schema versions', async function () {
    const { contractor } = this

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()
    assert.strictEqual(oneVersionAgo, currentSchemaVersion - 1)

    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.schemaVersion()
    assert.strictEqual(twoVersionsAgo, currentSchemaVersion - 2)

    const config = { ...this.bossConfig }
    this.boss = new PgBoss(config)
    await this.boss.start()

    const version = await contractor.schemaVersion()

    assert.strictEqual(version, currentSchemaVersion)
  })

  it('migrating to non-existent version fails gracefully', async function () {
    const { contractor } = this

    await contractor.create()

    try {
      await contractor.migrate('¯\\_(ツ)_//¯')
    } catch (error) {
      assert(error.message.includes('not found'))
    }
  })

  it('should roll back an error during a migration', async function () {
    const { contractor } = this

    const config = { ...this.bossConfig }

    config.migrations = getAll(config.schema)

    // add invalid sql statement
    config.migrations[0].install.push('wat')

    await contractor.create()
    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()

    const boss1 = new PgBoss(config)

    try {
      await boss1.start()
    } catch (error) {
      assert(error.message.includes('wat'))
    } finally {
      await boss1.stop({ graceful: false, wait: false })
    }

    const version1 = await contractor.schemaVersion()

    assert.strictEqual(version1, oneVersionAgo)

    // remove bad sql statement
    config.migrations[0].install.pop()

    const boss2 = new PgBoss(config)

    try {
      await boss2.start()

      const version2 = await contractor.schemaVersion()

      assert.strictEqual(version2, currentSchemaVersion)
    } finally {
      await boss2.stop({ graceful: false, wait: false })
    }
  })

  it('should not install if migrate option is false', async function () {
    const config = { ...this.bossConfig, migrate: false }
    this.boss = new PgBoss(config)
    await assert.rejects(async () => {
      await this.boss.start()
    })
  })

  it('should not migrate if migrate option is false', async function () {
    const { contractor } = this

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...this.bossConfig, migrate: false }
    this.boss = new PgBoss(config)

    await assert.rejects(async () => {
      await this.boss!.start()
    })
  })

  it('should still work if migrate option is false', async function () {
    const { contractor } = this

    await contractor.create()

    const config = { ...this.bossConfig, migrate: false }

    this.boss = new PgBoss(config)

    await this.boss.start()
    await this.boss.createQueue(this.schema)
    await this.boss.send(this.schema)
    const [job] = await this.boss.fetch(this.schema)
    await this.boss.complete(this.schema, job.id)
  })
})
