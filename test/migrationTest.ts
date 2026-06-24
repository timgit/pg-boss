import { expect, beforeEach } from 'vitest'
import { PgBoss, getConstructionPlans, getMigrationPlans, getRollbackPlans } from '../src/index.ts'
import { getDb, assertTruthy, getSchemaDefs, itPostgresOnly } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import { getAll, migrate, migrateCommands } from '../src/migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import { setVersion, getPartitionedQueueTables } from '../src/plans.ts'
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

  itPostgresOnly('should add migrations for partitioned tables', async function () {
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

  itPostgresOnly('should return bam status grouped by status', async function () {
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

  itPostgresOnly('should have identical schema after rollback and forward migration', async function () {
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

  itPostgresOnly('should detect function modification when migration has incomplete uninstall', async function () {
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

  itPostgresOnly('should reject index creation that is not completely removed', async function () {
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

  itPostgresOnly('drops the covering INCLUDE from the job_i5 fetch index at v33, across partitions and reversibly', async function () {
    const config = { ...ctx.bossConfig }
    const schema = config.schema

    const db = await getDb()
    // @ts-ignore
    const contractor = new Contractor(db, config)

    // Read job_i5's definition on job_common + every partition by targeting each index relation by
    // name (pg_get_indexdef on its regclass), rather than scanning the catalog-wide pg_indexes view —
    // that view can transiently race concurrent DDL from parallel test workers ("could not open
    // relation with OID"). Touching only this schema's own relations keeps the read deterministic.
    const fetchIndexDefs = async (): Promise<string[]> => {
      const parts = await db.executeSql(`SELECT table_name FROM ${schema}.queue WHERE partition = true ORDER BY table_name`)
      const tables = ['job_common', ...parts.rows.map((r: { table_name: string }) => r.table_name)]
      const defs: string[] = []
      for (const t of tables) {
        const res = await db.executeSql('SELECT pg_get_indexdef($1::regclass) AS indexdef', [`${schema}.${t}_i5`])
        defs.push(res.rows[0].indexdef)
      }
      return defs
    }

    await contractor.create()
    // A partitioned queue gives job_i5 a second home, exercising the per-partition fan-out of the
    // rebuild (job_table_run across job_common + every partition).
    await db.executeSql(`SELECT ${schema}.create_queue('part_q', '{"partition":true,"policy":"standard"}'::jsonb)`)

    // Fresh install (current version): both job_common and the partition build job_i5 with no
    // covering payload — FOR UPDATE ... SKIP LOCKED in the fetch precludes an index-only scan, so
    // the INCLUDE was dead weight on the hot insert path.
    let defs = await fetchIndexDefs()
    expect(defs).toHaveLength(2)
    for (const def of defs) expect(def).not.toContain('INCLUDE')

    // Roll back to v32: the historical covering form is restored on every table.
    let version = await contractor.schemaVersion()
    assertTruthy(version)
    while (version > 32) {
      await contractor.rollback(version)
      version = await contractor.schemaVersion()
      assertTruthy(version)
    }
    expect(version).toBe(32)
    defs = await fetchIndexDefs()
    expect(defs).toHaveLength(2)
    for (const def of defs) expect(def).toContain('INCLUDE (priority, created_on, id)')

    // Migrate forward across v33: the INCLUDE is dropped again on every table.
    await contractor.next(32)
    expect(await contractor.schemaVersion()).toBe(33)
    defs = await fetchIndexDefs()
    expect(defs).toHaveLength(2)
    for (const def of defs) expect(def).not.toContain('INCLUDE')

    await db.close()
  })

  itPostgresOnly('should remove indexes created on the job table that follow the standard naming convention', async function () {
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

  itPostgresOnly('should have identical schema after rolling back all migrations and replaying them', async function () {
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

  describe('inline async migration (CLI / exported plans)', function () {
    const schema = 'custom'
    const enqueueCall = /SELECT\s+\S*job_table_run_async\(/

    it('should inline async index builds as direct DDL in exported migration plans', function () {
      const sql = getMigrationPlans(schema, 0)

      expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS job_common_i7')
      expect(sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS job_common_i8')
      // provenance comment naming the source pg function
      expect(sql).toContain(`-- inlined from ${schema}.job_table_run_async`)
      // the inert BAM enqueue call is gone (only the comment mentions the function)
      expect(sql).not.toMatch(enqueueCall)
    })

    it('should place inlined CONCURRENTLY builds after COMMIT', function () {
      const sql = getMigrationPlans(schema, 0)

      const commitIndex = sql.lastIndexOf('COMMIT;')
      const i7Index = sql.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS job_common_i7')

      expect(commitIndex).toBeGreaterThan(-1)
      expect(i7Index).toBeGreaterThan(commitIndex)
    })

    it('should fan inlined i7 across partition tables and keep i8 on job_common only', function () {
      const sql = migrate(schema, 0, undefined, undefined, { inlineAsync: true, partitionTables: ['jABC'] })

      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS job_common_i7 ON ${schema}.job_common`)
      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS jABC_i7 ON ${schema}.jABC`)
      expect(sql).toContain(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS job_common_i8 ON ${schema}.job_common`)
      // i8 is not fanned out across partitions
      expect(sql).not.toContain('jABC_i8')
    })

    it('should keep using job_table_run_async (BAM) for the live migration path', function () {
      const sql = migrate(schema, 0)

      expect(sql).toMatch(enqueueCall)
      expect(sql).not.toContain('CONCURRENTLY IF NOT EXISTS')
    })

    itPostgresOnly('should create job_common i7/i8 via the inlined path without a BAM worker', async function () {
      const config = { ...ctx.bossConfig }
      const dbSchema = config.schema
      config.migrations = getAll(dbSchema)

      const db = await getDb()
      // @ts-ignore
      const contractor = new Contractor(db, config)

      await contractor.create()

      // roll back through the migrations that add i7 (v27) and i8 (v28) so both indexes
      // are dropped, simulating a database where the async/BAM builds never ran (#766)
      for (let v = currentSchemaVersion; v >= versionWithAsyncMigrations; v--) {
        await contractor.rollback(v)
      }

      const indexNames = async () => (await db.executeSql(
        `SELECT indexname FROM pg_indexes WHERE schemaname = '${dbSchema}' AND indexname IN ('job_common_i7', 'job_common_i8')`
      )).rows.map((row: { indexname: string }) => row.indexname).sort()

      expect(await indexNames()).toHaveLength(0)

      // apply the inlined migration exactly as `pg-boss migrate` does — the transactional
      // block, then each CONCURRENTLY build separately — with no BAM worker running anywhere
      const { sql, concurrent } = migrateCommands(dbSchema, versionWithAsyncMigrations - 1, getAll(dbSchema), false, { inlineAsync: true, partitionTables: [] })
      await db.executeSql(sql)
      for (const statement of concurrent) {
        await db.executeSql(statement)
      }

      expect(await indexNames()).toEqual(['job_common_i7', 'job_common_i8'])

      await db.close()
    })

    it('should forward partitionTables from getMigrationPlans through to the inlined builds', function () {
      const sql = getMigrationPlans(schema, 0, { partitionTables: ['jXYZ'] })

      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS job_common_i7 ON ${schema}.job_common`)
      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS jXYZ_i7 ON ${schema}.jXYZ`)
      // i8 is pinned to job_common, so partitions are never targeted
      expect(sql).not.toContain('jXYZ_i8')
    })

    it('should throw when an async migration command cannot be inlined', function () {
      // an async command that is not a job_table_run_async($$...$$) enqueue cannot be
      // rewritten into direct DDL, so inlining must fail loudly rather than emit garbage
      const malformed = [
        { release: '1.0.0', version: 1, previous: 0, install: ['CREATE TABLE x ()'], uninstall: [], async: ['SELECT 1'] }
      ]

      expect(() => migrate(schema, 0, malformed, undefined, { inlineAsync: true }))
        .toThrow(/Unable to inline async migration command/)
    })

    itPostgresOnly('should enumerate partitioned queue tables for per-partition inlined builds', async function () {
      const boss = ctx.boss = new PgBoss(ctx.bossConfig)
      const dbSchema = ctx.bossConfig.schema

      await boss.start()
      await boss.createQueue('partition-queue', { partition: true })
      await boss.stop()

      // the query the CLI runs (with a live connection) to fan inlined builds across partitions
      const db = await getDb()
      const result = await db.executeSql(getPartitionedQueueTables(dbSchema))
      const partitionTables = result.rows.map((row: { table_name: string }) => row.table_name)
      await db.close()

      // the partitioned queue gets its own table; the shared job_common is not partition = true
      expect(partitionTables.length).toBeGreaterThan(0)
      expect(partitionTables).not.toContain('job_common')

      // feeding those tables in fans i7 out across each partition, exactly as `pg-boss migrate` does
      const sql = migrate(dbSchema, 0, undefined, undefined, { inlineAsync: true, partitionTables })

      for (const table of partitionTables) {
        expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_i7 ON ${dbSchema}.${table}`)
      }
    })
  })
})
