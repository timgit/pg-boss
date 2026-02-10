import { expect, beforeEach } from 'vitest'
import { PgBoss, getConstructionPlans, getMigrationPlans, getRollbackPlans } from '../src/index.ts'
import { getDb, assertTruthy, getSchemaDefs } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import { getAll, migrate } from '../src/migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import { setVersion } from '../src/plans.ts'
import { ctx } from './hooks.ts'

const currentSchemaVersion = packageJson.pgboss.schema
// Version 27 has async migrations that create BAM entries for partitioned tables
const versionWithAsyncMigrations = 27

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

    for (let v = currentSchemaVersion; v > versionWithAsyncMigrations - 1; v--) {
      await contractor.rollback(v)
    }

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
    await boss.createQueue(ctx.schema, { partition: true })
    await boss.stop()

    // Rollback through each version to properly uninstall (e.g., drop warning table in v28)
    // then rollback to version with async migrations to test BAM status
    for (let v = currentSchemaVersion; v > versionWithAsyncMigrations - 1; v--) {
      await contractor.rollback(v)
    }

    await boss.start()

    // getBamStatus returns aggregated status counts - empty array if no BAM entries exist
    const bamStatus = await boss.getBamStatus()
    expect(Array.isArray(bamStatus)).toBe(true)
  })

  it('should have identical schema after rollback and forward migration', async function () {
    const config = { ...ctx.bossConfig }

    // Create initial schema
    await contractor.create()

    // Capture initial schema state
    const initialSchema = await getSchemaDefs([config.schema])

    // Rollback to previous version
    await contractor.rollback(currentSchemaVersion)
    const rolledBackVersion = await contractor.schemaVersion()

    assertTruthy(rolledBackVersion)
    expect(rolledBackVersion).toBe(currentSchemaVersion - 1)

    await contractor.migrate(rolledBackVersion)
    const migratedVersion = await contractor.schemaVersion()

    expect(migratedVersion).toBe(currentSchemaVersion)

    // Capture final schema state
    const finalSchema = await getSchemaDefs([config.schema])

    // Compare initial and final schemas - they should be identical
    expect(finalSchema.columns.rows.length).toBe(initialSchema.columns.rows.length)
    expect(finalSchema.indexes.rows.length).toBe(initialSchema.indexes.rows.length)
    expect(finalSchema.constraints.rows.length).toBe(initialSchema.constraints.rows.length)
    expect(finalSchema.functions.rows.length).toBe(initialSchema.functions.rows.length)

    // Deep comparison of actual schema objects
    expect(finalSchema.columns.rows).toEqual(initialSchema.columns.rows)
    expect(finalSchema.indexes.rows).toEqual(initialSchema.indexes.rows)
    expect(finalSchema.constraints.rows).toEqual(initialSchema.constraints.rows)
    expect(finalSchema.functions.rows).toEqual(initialSchema.functions.rows)
  })

  it('should detect function modification when migration has incomplete uninstall', async function () {
    const config = { ...ctx.bossConfig }

    // Get all real migrations
    config.migrations = getAll(config.schema)

    // Create contractor and schema
    const db = await getDb()
    // @ts-ignore
    const contractor = new Contractor(db, config)
    await contractor.create()

    // Capture the original schema state
    const originalSchema = await getSchemaDefs([config.schema])

    // Create a fake migration that modifies an existing function
    // This simulates changing business logic without properly restoring it on rollback
    const fakeMigrationVersion = currentSchemaVersion + 1

    const fakeMigration = {
      release: '99.0.0-test',
      version: fakeMigrationVersion,
      previous: currentSchemaVersion,
      install: [
        // Modify the job_table_format function to return something different
        `CREATE OR REPLACE FUNCTION ${config.schema}.job_table_format(command text, table_name text)
        RETURNS text AS
        $$
          -- MODIFIED VERSION: This now returns a hardcoded string instead of formatting
          SELECT 'modified_function_output'::text;
        $$
        LANGUAGE SQL IMMUTABLE`
      ],
      uninstall: [
      ]
    }

    config.migrations.push(fakeMigration)
    // @ts-ignore
    const modifiedContractor = new Contractor(db, config)

    await modifiedContractor.migrate(currentSchemaVersion)
    let version = await modifiedContractor.schemaVersion()
    expect(version).toBe(fakeMigrationVersion)

    await modifiedContractor.rollback(fakeMigrationVersion)
    version = await modifiedContractor.schemaVersion()
    expect(version).toBe(currentSchemaVersion)

    // Capture schema after rollback
    const rolledBackSchema = await getSchemaDefs([config.schema])

    await db.close()

    expect(rolledBackSchema.functions.rows).not.toEqual(originalSchema.functions.rows)
  })

  it('should reject index creation that is not completely removed', async function () {
    const config = { ...ctx.bossConfig }
    const schema = config.schema

    config.migrations = getAll(schema)

    const db = await getDb()
    // @ts-ignore
    const contractor = new Contractor(db, config)
    await contractor.create()

    const originalSchema = await getSchemaDefs([schema])

    const fakeMigrationVersion = currentSchemaVersion + 1

    const fakeMigration = {
      release: '99.0.0-test',
      version: fakeMigrationVersion,
      previous: currentSchemaVersion,
      install: [
        // indexes that have the naming convention job_i* are expected to be created by the job_table_run() function in the migration scripts.
        `SELECT ${schema}.job_table_run($cmd$CREATE INDEX job_i99 ON ${schema}.job (name, created_on)$cmd$, 'job_common')`
      ],
      uninstall: [
        // BUG: The uninstall should use job_table_run() as well to guarantee the index name matches.
        // In this case, IF EXISTS will bypass dropping it since then name doesn't match
        `DROP INDEX IF EXISTS ${schema}.job_i99`,
      ]
    }

    config.migrations.push(fakeMigration)
    // @ts-ignore
    const modifiedContractor = new Contractor(db, config)

    await modifiedContractor.migrate(currentSchemaVersion)
    let version = await modifiedContractor.schemaVersion()
    expect(version).toBe(fakeMigrationVersion)

    const intermediateSchema = await getSchemaDefs([schema])
    expect(intermediateSchema.indexes.rows.length).toBeGreaterThan(originalSchema.indexes.rows.length)

    await modifiedContractor.rollback(fakeMigrationVersion)
    version = await modifiedContractor.schemaVersion()
    expect(version).toBe(currentSchemaVersion)

    const rolledBackSchema = await getSchemaDefs([schema])

    await db.close()

    expect(rolledBackSchema.indexes.rows).not.toEqual(originalSchema.indexes.rows)
  })

  it('should remove indexes created on the job table that follow the standard naming convention', async function () {
    const config = { ...ctx.bossConfig }
    const schema = config.schema

    // Get all real migrations
    config.migrations = getAll(schema)

    // Create contractor and schema
    const db = await getDb()
    // @ts-ignore
    const contractor = new Contractor(db, config)
    await contractor.create()

    const originalSchema = await getSchemaDefs([schema])

    const fakeMigrationVersion = currentSchemaVersion + 1

    const fakeMigration = {
      release: '99.0.0-test',
      version: fakeMigrationVersion,
      previous: currentSchemaVersion,
      install: [
        // indexes that have the naming convention job_i* are expected to be created by the job_table_run() function in the migration scripts.
        `SELECT ${schema}.job_table_run($cmd$CREATE INDEX job_i99 ON ${schema}.job (name, created_on)$cmd$, 'job_common')`
      ],
      uninstall: [
        `SELECT ${schema}.job_table_run($cmd$DROP INDEX ${schema}.job_i99$cmd$, 'job_common')`,
      ]
    }

    config.migrations.push(fakeMigration)
    // @ts-ignore
    const modifiedContractor = new Contractor(db, config)

    await modifiedContractor.migrate(currentSchemaVersion)
    let version = await modifiedContractor.schemaVersion()
    expect(version).toBe(fakeMigrationVersion)

    const intermediateSchema = await getSchemaDefs([schema])
    expect(intermediateSchema.indexes.rows.length).toBeGreaterThan(originalSchema.indexes.rows.length)

    await modifiedContractor.rollback(fakeMigrationVersion)
    version = await modifiedContractor.schemaVersion()
    expect(version).toBe(currentSchemaVersion)

    const rolledBackSchema = await getSchemaDefs([schema])

    await db.close()

    expect(rolledBackSchema.indexes.rows).toEqual(originalSchema.indexes.rows)
  })

  it('should have identical schema after rolling back all migrations and replaying them', async function () {
    const config = { ...ctx.bossConfig }
    const schema = config.schema

    config.migrations = getAll(schema)

    const db = await getDb()
    // @ts-ignore
    const contractor = new Contractor(db, config)

    // Helper function to wait for BAM completion
    const waitForBamCompletion = async (boss: PgBoss, timeoutMs = 10000): Promise<void> => {
      const startTime = Date.now()
      while (true) {
        const bamStatus = await boss.getBamStatus()
        const pending = bamStatus.find(s => s.status === 'pending' || s.status === 'in_progress')

        if (!pending) {
          break  // All BAM migrations complete
        }

        if (Date.now() - startTime > timeoutMs) {
          throw new Error(`Timeout waiting for BAM completion. Status: ${JSON.stringify(bamStatus)}`)
        }

        await new Promise(resolve => setTimeout(resolve, 500))  // Poll every 500ms
      }
    }

    await contractor.create()

    // Start PgBoss with BAM enabled to process any async migrations in baseline
    const bamConfig = {
      noDefault: true,
      bamIntervalSeconds: 1,
      __test__bypass_bam_interval_check: true
    }
    const baselineBoss = new PgBoss({ ...config, ...bamConfig })
    await baselineBoss.start()
    await waitForBamCompletion(baselineBoss)
    await baselineBoss.stop()

    const baselineSchema = await getSchemaDefs([schema])

    // Find the earliest migration version
    const migrations = config.migrations
    const earliestMigration = migrations.reduce((min, m) => m.version < min.version ? m : min, migrations[0])

    for (let v = currentSchemaVersion; v > earliestMigration.version; v--) {
      await contractor.rollback(v)
    }

    const earliestVersion = await contractor.schemaVersion()
    expect(earliestVersion).toBe(earliestMigration.version)

    for (let v = earliestMigration.version; v < currentSchemaVersion; v++) {
      await contractor.migrate(v)
    }

    const finalVersion = await contractor.schemaVersion()
    expect(finalVersion).toBe(currentSchemaVersion)

    // Start PgBoss with BAM enabled to process any async migrations after replay
    const finalBoss = new PgBoss({ ...config, ...bamConfig })
    await finalBoss.start()
    await waitForBamCompletion(finalBoss)
    await finalBoss.stop()

    const finalSchema = await getSchemaDefs([schema])

    await db.close()

    expect(finalSchema.columns.rows).toEqual(baselineSchema.columns.rows)
    expect(finalSchema.indexes.rows).toEqual(baselineSchema.indexes.rows)
    expect(finalSchema.constraints.rows).toEqual(baselineSchema.constraints.rows)
    expect(finalSchema.functions.rows).toEqual(baselineSchema.functions.rows)
  })
})
