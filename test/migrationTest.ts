import { expect, beforeEach } from 'vitest'
import { PgBoss, getConstructionPlans, getMigrationPlans, getRollbackPlans } from '../src/index.ts'
import { getDb, assertTruthy } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import { getAll, migrate } from '../src/migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import { setVersion } from '../src/plans.ts'
import { ctx } from './hooks.ts'

const currentSchemaVersion = packageJson.pgboss.schema

describe('migration', function () {
  let contractor: Contractor

  beforeEach(async function () {
    const db = await getDb({ debug: false })
    // @ts-ignore
    contractor = new Contractor(db, ctx.bossConfig)
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
    const config = { ...ctx.bossConfig, createSchema: false }
    ctx.boss = new PgBoss(config)
    await expect(async () => {
      await ctx.boss!.start()
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
    const config = { ...ctx.bossConfig }

    await contractor.create()

    const db = await getDb()
    // version 20 was v9 and dropped from the migration store with v10
    await db.executeSql(setVersion(config.schema, 20))

    ctx.boss = new PgBoss(config)

    await expect(async () => {
      await ctx.boss!.start()
    }).rejects.toThrow()
  })

  it.skip('should migrate to previous version and back again', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oldVersion = await contractor.schemaVersion()

    expect(oldVersion).not.toBe(currentSchemaVersion)
    expect(oldVersion).not.toBeNull()

    assertTruthy(oldVersion)
    await contractor.migrate(oldVersion)
    const newVersion = await contractor.schemaVersion()

    expect(newVersion).toBe(currentSchemaVersion)
  })

  it('should install next version via contractor', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const oneVersionAgo = await contractor.schemaVersion()

    assertTruthy(oneVersionAgo)
    await contractor.next(oneVersionAgo)

    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)
  })

  it('should migrate to latest during start if on previous schema version', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...ctx.bossConfig }

    ctx.boss = new PgBoss(config)

    await ctx.boss.start()

    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)
  })

  it.skip('should migrate through 2 versions back and forth', async function () {
    const queue = 'migrate-back-2-and-forward'

    const config = { ...ctx.bossConfig }

    ctx.boss = new PgBoss(config)

    await ctx.boss.start()

    // creating jobs in 3 states to have data to migrate back and forth

    // completed job
    await ctx.boss.createQueue(queue)
    await ctx.boss.send(queue)
    const [job] = await ctx.boss.fetch(queue)
    await ctx.boss.complete(queue, job.id)

    // created job
    await ctx.boss.send(queue)

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()

    expect(oneVersionAgo).not.toBe(currentSchemaVersion)

    assertTruthy(oneVersionAgo)
    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.schemaVersion()

    expect(twoVersionsAgo).not.toBe(oneVersionAgo)

    assertTruthy(twoVersionsAgo)
    await contractor.next(twoVersionsAgo)
    const oneVersionAgoPart2 = await contractor.schemaVersion()

    expect(oneVersionAgo).toBe(oneVersionAgoPart2)

    await contractor.next(oneVersionAgo)
    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)

    await ctx.boss.send(queue)
    const [job2] = await ctx.boss.fetch(queue)
    await ctx.boss.complete(queue, job2.id)
  })

  it.skip('should migrate to latest during start if on previous 2 schema versions', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oneVersionAgo = await contractor.schemaVersion()
    expect(oneVersionAgo).toBe(currentSchemaVersion - 1)

    assertTruthy(oneVersionAgo)
    await contractor.rollback(oneVersionAgo)
    const twoVersionsAgo = await contractor.schemaVersion()
    expect(twoVersionsAgo).toBe(currentSchemaVersion - 2)

    const config = { ...ctx.bossConfig }
    ctx.boss = new PgBoss(config)
    await ctx.boss.start()

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
    const config = { ...ctx.bossConfig }

    config.migrations = getAll(config.schema)

    // add invalid sql statement to the latest migration
    config.migrations[config.migrations.length - 1].install.push('wat')

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

    // remove bad sql statement from the latest migration
    config.migrations[config.migrations.length - 1].install.pop()

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
    const config = { ...ctx.bossConfig, migrate: false }
    ctx.boss = new PgBoss(config)
    await expect(async () => {
      await ctx.boss!.start()
    }).rejects.toThrow()
  })

  it('should not migrate if migrate option is false', async function () {
    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const config = { ...ctx.bossConfig, migrate: false }
    ctx.boss = new PgBoss(config)

    await expect(async () => {
      await ctx.boss!.start()
    }).rejects.toThrow()
  })

  it('should still work if migrate option is false', async function () {
    await contractor.create()

    const config = { ...ctx.bossConfig, migrate: false }

    ctx.boss = new PgBoss(config)

    await ctx.boss.start()
    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)
  })

  it('should apply multiple migrations in version order', function () {
    const schema = 'test_schema'
    const mockMigrations = [
      { release: '1.2.0', version: 12, previous: 11, install: ['sql_v12'], uninstall: [] },
      { release: '1.1.0', version: 11, previous: 10, install: ['sql_v11'], uninstall: [] },
      { release: '1.3.0', version: 13, previous: 12, install: ['sql_v13'], uninstall: [] }
    ]

    const result = migrate(schema, 10, mockMigrations)

    expect(result).toContain('sql_v11')
    expect(result).toContain('sql_v12')
    expect(result).toContain('sql_v13')
    // Verify order: v11 should come before v12, v12 before v13
    expect(result.indexOf('sql_v11')).toBeLessThan(result.indexOf('sql_v12'))
    expect(result.indexOf('sql_v12')).toBeLessThan(result.indexOf('sql_v13'))
  })

  it('should add migrations for partitioned tables', async function () {
    const boss = ctx.boss = new PgBoss(ctx.bossConfig)
    await boss.start()
    await boss.createQueue(ctx.schema, { partition: true })
    await boss.stop()

    await contractor.rollback(currentSchemaVersion)

    await boss.start()

    const version = await contractor.schemaVersion()

    expect(version).toBe(currentSchemaVersion)

    // v28 (key_strict_fifo) doesn't have async migrations, so no BAM entries are created
    // BAM entries are only created for migrations with async sections (like v27's group_concurrency_index)
    const bamEntries = await boss.getBamEntries()
    expect(Array.isArray(bamEntries)).toBe(true)
  })

  it('should return bam status grouped by status', async function () {
    const boss = ctx.boss = new PgBoss(ctx.bossConfig)
    await boss.start()

    // getBamStatus returns aggregated status counts - empty array if no BAM entries exist
    const bamStatus = await boss.getBamStatus()
    expect(Array.isArray(bamStatus)).toBe(true)
  })
})
