import { expect, beforeEach } from 'vitest'
import { PgBoss, getConstructionPlans, getMigrationPlans, getRollbackPlans } from '../src/index.ts'
import { getDb } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import { getAll } from '../src/migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import { setVersion } from '../src/plans.ts'
import { testContext } from './hooks.ts'

const currentSchemaVersion = packageJson.pgboss.schema

describe('migration', function () {
  let contractor: Contractor

  beforeEach(async function () {
    const db = await getDb({ debug: false })
    // @ts-ignore
    contractor = new Contractor(db, testContext.bossConfig)
  })

  it('should include create schema by default ', function () {
    const schema = 'custom'
    const plans = Contractor.constructionPlans(schema)
    expect(plans).toContain('CREATE SCHEMA')
  })

  it('should not include create schema if createSchema=false', function () {
    const schema = 'custom'
    const plans = Contractor.constructionPlans(schema, { createSchema: false })
    expect(plans).not.toContain('CREATE SCHEMA')
  })

  it('should not install if createSchema option is false and schema is missing', async function () {
    const config = { ...testContext.bossConfig, createSchema: false }
    testContext.boss = new PgBoss(config)
    await expect(async () => {
      await testContext.boss!.start()
    }).rejects.toThrow()
  })

  it('should export commands to manually build schema', function () {
    const schema = 'custom'
    const plans = getConstructionPlans(schema)

    expect(plans).toContain(`${schema}.job`)
    expect(plans).toContain(`${schema}.version`)
  })

  it('should fail to export migration using current version', function () {
    const schema = 'custom'

    expect(() => {
      getMigrationPlans(schema, currentSchemaVersion)
    }).toThrow()
  })

  it('should export commands to migrate', function () {
    const schema = 'custom'
    const plans = getMigrationPlans(schema, currentSchemaVersion - 1)

    expect(plans).toBeTruthy()
  })

  it('should fail to export commands to roll back from invalid version', function () {
    const schema = 'custom'

    expect(() => {
      getRollbackPlans(schema, -1)
    }).toThrow()
  })

  it('should export commands to roll back', function () {
    const schema = 'custom'
    const plans = getRollbackPlans(schema, currentSchemaVersion)

    expect(plans).toBeTruthy()
  })

  it('should not migrate when current version is not found in migration store', async function () {
    const config = { ...testContext.bossConfig }

    await contractor.create()

    const db = await getDb()
    // version 20 was v9 and dropped from the migration store with v10
    await db.executeSql(setVersion(config.schema, 20))

    testContext.boss = new PgBoss(config)

    await expect(async () => {
      await testContext.boss!.start()
    }).rejects.toThrow()
  })

  it.skip('should migrate to previous version and back again', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oldVersion = await contractor.schemaVersion()

    expect(oldVersion).not.toBe(currentSchemaVersion)
    expect(oldVersion).not.toBeNull()

    await contractor.migrate(oldVersion!)
    const newVersion = await contractor.schemaVersion()

    expect(newVersion).toBe(currentSchemaVersion)
  })

  it('should install next version via contractor', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const oneVersionAgo = await contractor.schemaVersion()

    await contractor.next(oneVersionAgo!)

    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)
  })

  it('should migrate to latest during start if on previous schema version', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...testContext.bossConfig }

    testContext.boss = new PgBoss(config)

    await testContext.boss.start()

    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)
  })

  it.skip('should migrate through 2 versions back and forth', async function () {
    const queue = 'migrate-back-2-and-forward'

    const config = { ...testContext.bossConfig }

    testContext.boss = new PgBoss(config)

    await testContext.boss.start()

    // creating jobs in 3 states to have data to migrate back and forth

    // completed job
    await testContext.boss.createQueue(queue)
    await testContext.boss.send(queue)
    const [job] = await testContext.boss.fetch(queue)
    await testContext.boss.complete(queue, job.id)

    // created job
    await testContext.boss.send(queue)

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()

    expect(oneVersionAgo).not.toBe(currentSchemaVersion)

    await contractor.rollback(oneVersionAgo!)
    const twoVersionsAgo = await contractor.schemaVersion()

    expect(twoVersionsAgo).not.toBe(oneVersionAgo)

    await contractor.next(twoVersionsAgo!)
    const oneVersionAgoPart2 = await contractor.schemaVersion()

    expect(oneVersionAgo).toBe(oneVersionAgoPart2)

    await contractor.next(oneVersionAgo!)
    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)

    await testContext.boss.send(queue)
    const [job2] = await testContext.boss.fetch(queue)
    await testContext.boss.complete(queue, job2.id)
  })

  it.skip('should migrate to latest during start if on previous 2 schema versions', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()
    expect(oneVersionAgo).toBe(currentSchemaVersion - 1)

    await contractor.rollback(oneVersionAgo!)
    const twoVersionsAgo = await contractor.schemaVersion()
    expect(twoVersionsAgo).toBe(currentSchemaVersion - 2)

    const config = { ...testContext.bossConfig }
    testContext.boss = new PgBoss(config)
    await testContext.boss.start()

    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)
  })

  it('migrating to non-existent version fails gracefully', async function () {
    await contractor.create()

    try {
      // @ts-expect-error testing invalid version type
      await contractor.migrate('¯\\_(ツ)_//¯')
    } catch (error: any) {
      expect(error.message).toContain('not found')
    }
  })

  it('should roll back an error during a migration', async function () {
    const config = { ...testContext.bossConfig }

    config.migrations = getAll(config.schema)

    // add invalid sql statement
    config.migrations[0].install.push('wat')

    await contractor.create()
    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()

    const boss1 = new PgBoss(config)

    try {
      await boss1.start()
    } catch (error: any) {
      expect(error.message).toContain('wat')
    } finally {
      await boss1.stop({ graceful: false })
    }

    const version1 = await contractor.schemaVersion()

    expect(version1).toBe(oneVersionAgo)

    // remove bad sql statement
    config.migrations[0].install.pop()

    const boss2 = new PgBoss(config)

    try {
      await boss2.start()

      const version2 = await contractor.schemaVersion()

      expect(version2).toBe(currentSchemaVersion)
    } finally {
      await boss2.stop({ graceful: false })
    }
  })

  it('should not install if migrate option is false', async function () {
    const config = { ...testContext.bossConfig, migrate: false }
    testContext.boss = new PgBoss(config)
    await expect(async () => {
      await testContext.boss!.start()
    }).rejects.toThrow()
  })

  it('should not migrate if migrate option is false', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...testContext.bossConfig, migrate: false }
    testContext.boss = new PgBoss(config)

    await expect(async () => {
      await testContext.boss!.start()
    }).rejects.toThrow()
  })

  it('should still work if migrate option is false', async function () {
    await contractor.create()

    const config = { ...testContext.bossConfig, migrate: false }

    testContext.boss = new PgBoss(config)

    await testContext.boss.start()
    await testContext.boss.createQueue(testContext.schema)
    await testContext.boss.send(testContext.schema)
    const [job] = await testContext.boss.fetch(testContext.schema)
    await testContext.boss.complete(testContext.schema, job.id)
  })
})
