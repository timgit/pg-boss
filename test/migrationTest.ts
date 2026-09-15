import { expect, beforeEach } from 'vitest'
import { PgBoss, getConstructionPlans, getMigrationPlans, getRollbackPlans } from '../src/index.ts'
import { getDb, assertTruthy, getSchemaDefs, itPostgresOnly, start } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import { getAll, getAllForConfig, migrate, migrateCommands, getMinVersion, next } from '../src/migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import { setVersion, getPartitionedQueueTables, jobTableFormatFunction, bamCommandIndexName } from '../src/plans.ts'
import { ctx } from './hooks.ts'
import type * as types from '../src/types.ts'
import schemaManifest from '../src/schema.json' with { type: 'json' }
import { extractFunctionBody } from '../src/drifter.ts'

const currentSchemaVersion = packageJson.pgboss.schema
// Version 27 has async migrations that create BAM entries for partitioned tables
const versionWithAsyncMigrations = 27

// How many migrations back the round-trip and async-lifecycle tests reach, counted from the current
// schema version rather than pinned to any particular one. This is the knob that keeps these tests
// from accreting: a new migration is covered the moment it is added, and nothing needs editing.
// Raise it locally (MIGRATION_DEPTH=10) to sweep further back.
const MIGRATION_DEPTH = Math.min(
  Number(process.env.MIGRATION_DEPTH ?? 3),
  currentSchemaVersion - getMinVersion('x')!
)

// The newest migration that enqueues async (BAM) work, discovered from the migration list. Used by
// the async-lifecycle tests so they follow the migrations rather than naming one.
function newestAsyncMigration (schema = 'x') {
  return getAll(schema)
    .filter(m => Array.isArray(m.async) && m.async.length > 0)
    .sort((a, b) => b.version - a.version)[0]
}

describe('migration', function () {
  let contractor: Contractor

  // rollback(v) uninstalls v, leaving v-1, so reaching an older version means walking down.
  async function rollbackTo (target: number) {
    for (let v = currentSchemaVersion; v > target; v--) {
      await contractor.rollback(v)
    }
  }

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

  it('should refuse to migrate from a version below the oldest supported floor', function () {
    // The oldest migration starts from version 25. Migrating from anything lower would apply the
    // whole chain over missing intermediate steps, so it must fail loudly with a clear message.
    expect(() => migrate('custom', 10)).toThrow(/oldest supported starting version/)

    // the floor itself is fine
    expect(() => migrate('custom', 25)).not.toThrow()
  })

  it('should guard the v27 async index drop with IF EXISTS on rollback', function () {
    // job_i7 is built asynchronously via BAM, so a rollback before that build ran would abort the
    // whole transaction on "index does not exist" without IF EXISTS.
    const sql = getRollbackPlans('custom', 27)
    expect(sql).toContain('DROP INDEX IF EXISTS custom.job_i7')
  })

  it('should not corrupt a schema name that contains the job_i token when inlining', function () {
    // formatJobTable used naive substring replacement; a schema like `job_intake` (contains job_i)
    // got rewritten to `job_common_intake`. The inlined async DDL must reference the real schema.
    const sql = migrate('job_intake', 26, undefined, undefined, { inlineAsync: true })
    expect(sql).toContain('job_intake.job_common')
    expect(sql).not.toContain('job_common_intake')
  })

  itPostgresOnly('job_table_format() (plpgsql) handles a schema name containing the job_i token (v37)', async function () {
    // The installed SQL function used the same naive replace() as formatJobTable did. A schema like
    // `job_intake` (contains `job_i`) got rewritten to `job_common_intake` — an index build against a
    // nonexistent schema. The v37 anchored regexp_replace version rewrites only the base table
    // reference and bare job_iN tokens.
    const db = await getDb()
    const schema = 'job_intake'

    await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.executeSql(`CREATE SCHEMA ${schema}`)
    try {
      await db.executeSql(jobTableFormatFunction(schema))

      const command = `CREATE INDEX job_i5 ON ${schema}.job (name)`
      const { rows } = await db.executeSql(`SELECT ${schema}.job_table_format($1, 'job_common') as out`, [command])

      expect(rows[0].out).toBe(`CREATE INDEX job_common_i5 ON ${schema}.job_common (name)`)
      expect(rows[0].out).not.toContain('job_common_intake')
    } finally {
      await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  })

  // Finds statements that write a column the same migration added above them. CockroachDB runs
  // ADD COLUMN as a schema-change job, so the transaction that added a column cannot then write it:
  // the statement fails with 42P10 "column is being backfilled" and takes the whole migration with
  // it. Both tests below walk the rendered list rather than naming versions, so the next migration
  // to seed a column is covered without either of them being edited.
  function sameTransactionBackfills (migration: types.Migration) {
    const addColumn = /ALTER TABLE\s+custom\.(\w+)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+(\w+)/i
    const added = new Map<string, Set<string>>()
    const found: string[] = []

    for (const command of migration.install) {
      const match = command.match(addColumn)

      if (match) {
        const [, table, column] = match
        if (!added.has(table)) added.set(table, new Set())
        added.get(table)!.add(column.toLowerCase())
        continue
      }

      const update = command.match(/UPDATE\s+custom\.(\w+)[\s\S]*?\bSET\b([\s\S]*)/i)
      if (!update) continue

      const [, table, assignments] = update
      for (const column of added.get(table) ?? []) {
        if (new RegExp(`\\b${column}\\s*=`, 'i').test(assignments)) {
          found.push(command)
        }
      }
    }

    return found
  }

  it('leaves out every same-transaction backfill when noAddColumnBackfill is set', function () {
    // A migration that seeds a new column has to leave the seed out under noAddColumnBackfill and
    // arrange for the runtime to read the same answer without it (v40 falls back to monitor_on; v41
    // relabels on the first cron pass). Nothing may survive the gate.
    const offenders = getAll('custom', false, false, true)
      .flatMap(m => sameTransactionBackfills(m).map(c => `v${m.version}: ${c.trim().split('\n')[0]}`))

    expect(offenders).toEqual([])
  })

  it('drops only the backfills when noAddColumnBackfill is set, never anything else', function () {
    // The other half of the gate: a migration must not take unrelated statements out with the
    // backfill. Anything the flag removes has to be a statement the flag exists to remove, so a
    // CockroachDB schema ends up differing from a Postgres one by the seed values alone.
    const standard = getAll('custom')
    const distributed = getAll('custom', false, false, true)

    expect(distributed.map(m => m.version)).toEqual(standard.map(m => m.version))

    for (const [index, migration] of standard.entries()) {
      const backfills = new Set(sameTransactionBackfills(migration))
      const expected = migration.install.filter(c => !backfills.has(c))

      expect(distributed[index].install, `v${migration.version}`).toEqual(expected)
      expect(distributed[index].uninstall, `v${migration.version}`).toEqual(migration.uninstall)
    }
  })

  it('getMinVersion returns the lowest previous version in the migration set', function () {
    // The oldest migration is v26 (previous: 25), so no chain exists below 25.
    expect(getMinVersion('custom')).toBe(25)
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

  it('shapes every exported plan for the backend it names', function () {
    // Exported SQL is run by hand, against whatever engine the caller has: the same three functions
    // the CLI wraps, which takes --backend for exactly this reason. Stock PostgreSQL stays the
    // default, so a caller that names nothing gets what it always got.
    const schema = 'custom'
    // Start below the oldest migration that seeds a backfill, so every seed the gate drops is in range.
    const from = Math.min(...getAll(schema).filter(m => sameTransactionBackfills(m).length > 0).map(m => m.previous))

    const stock = {
      construction: getConstructionPlans(schema),
      migration: getMigrationPlans(schema, from),
      rollback: getRollbackPlans(schema, currentSchemaVersion)
    }

    const distributed = {
      construction: getConstructionPlans(schema, { backend: 'cockroachdb' }),
      migration: getMigrationPlans(schema, from, { backend: 'cockroachdb' }),
      rollback: getRollbackPlans(schema, currentSchemaVersion, { backend: 'cockroachdb' })
    }

    // The advisory lock wraps all three, so it is the one gate every plan can be checked against.
    for (const kind of ['construction', 'migration', 'rollback'] as const) {
      expect(stock[kind], kind).toContain('pg_advisory_xact_lock')
      expect(distributed[kind], kind).not.toContain('pg_advisory_xact_lock')
    }

    // The schema choices CockroachDB rejects outright.
    expect(stock.construction).toMatch(/PARTITION BY/)
    expect(distributed.construction).not.toMatch(/PARTITION BY|ATTACH PARTITION|INCLUDE \(|DEFERRABLE/)

    // And the seeds noAddColumnBackfill drops, found the same way the gate's own tests find them
    // rather than by naming a version.
    const squash = (sql: string) => sql.replace(/\s+/g, ' ')
    const dropped = getAll(schema).flatMap(sameTransactionBackfills)

    expect(dropped.length).toBeGreaterThan(0)

    for (const statement of dropped) {
      expect(squash(stock.migration)).toContain(squash(statement))
      expect(squash(distributed.migration)).not.toContain(squash(statement))
    }
  })

  it('keeps the other plan options working alongside a backend', function () {
    // backend is an addition to these signatures, not a replacement: what each function already
    // took has to keep working, with or without one.
    expect(getConstructionPlans('custom', { createSchema: false })).not.toContain('CREATE SCHEMA')
    expect(getConstructionPlans('custom', { createSchema: false, backend: 'cockroachdb' })).not.toContain('CREATE SCHEMA')
    expect(getConstructionPlans('custom', { backend: 'cockroachdb' })).toContain('CREATE SCHEMA')

    // A backend nobody has a profile for is rejected where it is named, not carried into the SQL.
    // @ts-expect-error deliberately naming a backend that is not a profile
    expect(() => getMigrationPlans('custom', currentSchemaVersion - 1, { backend: 'mysql' })).toThrow(/backend must be one of/)
  })

  it('exports plans for a backend that keeps some of the postgres schema choices', function () {
    // Not every distributed engine drops the same things: YugabyteDB runs the standard fetch path
    // and keeps covering indexes and deferrable constraints, and only loses advisory locks and
    // table partitioning. A single "distributed" switch here would have taken all four.
    const yugabyte = getConstructionPlans('custom', { backend: 'yugabytedb' })

    expect(yugabyte).not.toContain('pg_advisory_xact_lock')
    expect(yugabyte).not.toMatch(/PARTITION BY/)
    expect(yugabyte).toMatch(/INCLUDE \(/)
    expect(yugabyte).toMatch(/DEFERRABLE/)
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

  it('should migrate to previous version and back again', async function () {
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

  it('should migrate through 2 versions back and forth', async function () {
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

  it('should migrate to latest during start if on previous 2 schema versions', async function () {
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

    config.migrations = getAllForConfig(config)

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

  // Rolls back `depth` migrations and replays them, then asserts the schema is byte-identical to a
  // fresh install. This is the test that replaces per-migration schema assertions: because the
  // window is relative to currentSchemaVersion, every new migration is covered the moment it lands
  // and no test needs to be written or edited for it.
  //
  // What it catches, generically: an uninstall that does not fully reverse its install, an index or
  // constraint left behind or not rebuilt, a create_queue snapshot that drifts from the live
  // function, and async (BAM) work that never converges.
  async function assertRoundTripConverges (depth: number) {
    const config = { ...ctx.bossConfig }

    await contractor.create()

    // A dedicated partition per policy, so the comparison covers the per-partition fan-out and the
    // policy-scoped index builds — not just job_common. Without these, a migration that built the
    // wrong index on the wrong partition would round-trip clean.
    const db = await getDb()
    try {
      for (const policy of ['standard', 'short', 'singleton', 'stately', 'exclusive', 'key_strict_fifo']) {
        await db.executeSql(
          `SELECT ${config.schema}.create_queue($1, $2::jsonb)`,
          [`part_${policy}`, JSON.stringify({ partition: true, policy })])
      }
    } finally {
      await db.close()
    }

    const fresh = await getSchemaDefs([config.schema])

    for (let i = 0; i < depth; i++) {
      const version = await contractor.schemaVersion()
      assertTruthy(version)
      await contractor.rollback(version)
    }

    const rolledBackTo = await contractor.schemaVersion()
    assertTruthy(rolledBackTo)
    expect(rolledBackTo).toBe(currentSchemaVersion - depth)

    await contractor.migrate(rolledBackTo)
    expect(await contractor.schemaVersion()).toBe(currentSchemaVersion)

    // Migrations defer index work to BAM, so the schema has not converged until BAM drains.
    const boss = ctx.boss = await start({
      ...config,
      noDefault: true,
      bamIntervalSeconds: 1,
      __test__bypass_bam_interval_check: true
    })
    await expect.poll(async () => {
      const status = await boss.getBamStatus()
      return status.filter(item => item.status !== 'completed').reduce((sum, item) => sum + item.count, 0)
    }, { timeout: 45000 }).toBe(0)
    await boss.stop()

    const replayed = await getSchemaDefs([config.schema])

    for (const part of ['columns', 'indexes', 'constraints', 'functions'] as const) {
      expect(replayed[part].rows, `${part} differ after rolling back ${depth} and replaying`)
        .toEqual(fresh[part].rows)
    }
  }

  for (let depth = 1; depth <= MIGRATION_DEPTH; depth++) {
    itPostgresOnly(`converges on the fresh-install schema after rolling back ${depth} and replaying`, { timeout: 90000 }, async function () {
      await assertRoundTripConverges(depth)
    })
  }

  // The async (BAM) lifecycle, driven by whichever migration most recently enqueues async work
  // rather than by a named version. Covers what the per-migration BAM tests used to assert one
  // migration at a time: commands are enqueued for the right tables, they drain, and rolling the
  // version back removes any that never ran.
  itPostgresOnly('enqueues async work for the newest async migration and clears it on rollback', { timeout: 90000 }, async function () {
    const schema = ctx.bossConfig.schema
    const target = newestAsyncMigration()
    assertTruthy(target)

    const db = await getDb()

    try {
      await contractor.create()
      // A partitioned queue gives the fan-out a second table to reach.
      await db.executeSql(`SELECT ${schema}.create_queue('part_q', '{"partition":true,"policy":"standard"}'::jsonb)`)

      await rollbackTo(target.previous)
      expect(await contractor.schemaVersion()).toBe(target.previous)

      await contractor.migrate(target.previous)
      expect(await contractor.schemaVersion()).toBe(currentSchemaVersion)

      // Enqueued, not yet run: the migration transaction must not do index work inline (issue #832).
      const { rows: queued } = await db.executeSql(
        `SELECT count(*)::int AS count FROM ${schema}.bam WHERE version = $1 AND status <> 'completed'`,
        [target.version])
      expect(queued[0].count).toBeGreaterThan(0)

      // Rolling the version back must remove its unfinished commands, so a later replay does not
      // apply DDL belonging to a version the schema is no longer on.
      await rollbackTo(target.previous)
      const { rows: cleared } = await db.executeSql(
        `SELECT count(*)::int AS count FROM ${schema}.bam WHERE version = $1 AND status <> 'completed'`,
        [target.version])
      expect(cleared[0].count).toBe(0)
    } finally {
      await db.close()
    }
  })

  // Every index a migration creates must be gone once that migration is rolled back.
  //
  // This is the property the round-trip test cannot see: an uninstall that fails to drop what its
  // install created is invisible to a before/after comparison, because replaying the migration
  // recreates the object idempotently and the end state matches anyway. The leak only shows at the
  // intermediate version. Index names are read out of each migration's own DDL, so this follows the
  // migration list rather than naming versions.
  itPostgresOnly('drops every index a migration created when that migration is rolled back', { timeout: 90000 }, async function () {
    const schema = ctx.bossConfig.schema
    const migrations = getAllForConfig(ctx.bossConfig)
      .filter(m => m.version > currentSchemaVersion - MIGRATION_DEPTH)
      .sort((a, b) => b.version - a.version)

    const db = await getDb()

    try {
      await contractor.create()
      await db.executeSql(
        `SELECT ${schema}.create_queue($1, $2::jsonb)`,
        ['part_q', JSON.stringify({ partition: true, policy: 'key_strict_fifo' })])

      for (const migration of migrations) {
        const commands = [
          ...(migration.install ?? []),
          ...(migration.async ?? []).map(a => typeof a === 'string' ? a : a.command)
        ]

        // The bare job_iN token each command builds, before per-partition renaming.
        //
        // Function bodies are excluded: a migration that only re-declares create_queue carries a
        // CREATE INDEX for every index in the schema, none of which it introduces. Rolling it back
        // is not supposed to drop them, and counting them here reports the whole index set as
        // leaked. Only standalone index DDL states what a migration actually adds.
        const indexNames = (list: string[]) => new Set(list
          .filter(command => !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(command))
          .map(command => bamCommandIndexName(command))
          .filter((name): name is string => !!name))

        // An index the uninstall also creates is being *reshaped* by this migration, not introduced
        // by it (v33 rebuilds job_i5 in place), and is meant to survive the rollback. Only what a
        // migration adds outright is expected to disappear — for v40 that is job_i11, which the
        // rollback drops, while the job_i5 its uninstall recreates is a restoration, not a leak.
        const restored = indexNames((migration.uninstall ?? []) as string[])
        const created = [...indexNames(commands)].filter(name => !restored.has(name))

        await contractor.rollback(migration.version)
        expect(await contractor.schemaVersion()).toBe(migration.previous)

        for (const index of created) {
          // Migrations spell indexes as the bare job_iN token; job_table_format renames them per
          // table (job_i10 -> job_common_i10, <partition>_i10), so match on the suffix.
          const suffix = index.replace(/^job_/, '')

          const { rows } = await db.executeSql(
            `SELECT c.relname FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relkind IN ('i','I')
                AND (c.relname = $2 OR c.relname LIKE '%\\_' || $3)`,
            [schema, index, suffix])

          expect(rows.map((r: { relname: string }) => r.relname),
            `v${migration.version} created ${index} but its rollback left it behind`).toEqual([])
        }
      }
    } finally {
      await db.close()
    }
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

    const boss = ctx.boss = await start({
      ...config,
      noDefault: true,
      bamIntervalSeconds: 1,
      __test__bypass_bam_interval_check: true
    })
    await expect.poll(async () => {
      const status = await boss.getBamStatus()
      return status.filter(item => item.status !== 'completed').reduce((sum, item) => sum + item.count, 0)
    }, { timeout: 10000 }).toBe(0)
    await boss.stop()

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
    config.migrations = getAllForConfig(config)

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

    config.migrations = getAllForConfig(config)

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

  // Version-pinned on purpose, and one of the few that should be. It does not assert a rule every
  // migration has to follow - a migration that reshapes an index in place has to drop before it
  // creates - it asserts the ordering of one swap that had to be got right once. It does not grow
  // with the migration list.
  it('builds a replacement fetch index before retiring the one it replaces, in both directions', function () {
    const forward = getAll('custom').find(m => m.version === 40)
    assertTruthy(forward)

    // Install: build job_i11 on every table, then retire job_i5. BAM runs one command per interval,
    // so the reverse order would leave every job table with no fetch index for one interval per
    // partition. The same ordering applies to the rollback, which restores job_i5 before dropping
    // job_i11 rather than the other way round.
    const async = (forward.async ?? []).map(c => (typeof c === 'string' ? c : c.command))
    const build = async.findIndex(c => /CREATE INDEX CONCURRENTLY .*job_i11/.test(c))
    const retire = async.findIndex(c => /DROP INDEX CONCURRENTLY .*job_i5/.test(c))

    expect(build).toBeGreaterThanOrEqual(0)
    expect(retire).toBeGreaterThan(build)

    const uninstall = (forward.uninstall ?? []) as string[]
    const restore = uninstall.findIndex(c => /CREATE INDEX IF NOT EXISTS job_i5/.test(c))
    const drop = uninstall.findIndex(c => /DROP INDEX IF EXISTS .*job_i11/.test(c))

    expect(restore).toBeGreaterThanOrEqual(0)
    expect(drop).toBeGreaterThan(restore)

    // IF NOT EXISTS, not a drop-and-rebuild: v40 never reshapes job_i5, so one still present is
    // already the v39 shape and must not be rebuilt for nothing.
    expect(uninstall.some(c => /DROP INDEX IF EXISTS .*job_i5/.test(c))).toBe(false)
  })

  itPostgresOnly('labels every schedule stored before v41 from the expression on it', async function () {
    const schema = ctx.bossConfig.schema
    const db = await getDb()

    try {
      await contractor.create()
      await db.executeSql(`SELECT ${schema}.create_queue('sched_q', '{"policy":"standard"}'::jsonb)`)

      await rollbackTo(40)

      const store = (key: string, cron: string) => db.executeSql(
        `INSERT INTO ${schema}.schedule (name, key, cron, timezone) VALUES ('sched_q', $1, $2, 'UTC')`,
        [key, cron])

      // A row written while cron was the only format a schedule could hold, which is every row a
      // database upgrading to v41 for the first time holds.
      await store('nightly', '0 3 * * *')

      // And the rows a rollback to v40 leaves behind, which dropping the column took the format of.
      // The default alone would label these cron, and the pass would then read a rule as a cron
      // expression and warn about it every 30 seconds instead of firing it. Both the bare rule and
      // the property at the head of a line are matched, the second on a line below the first.
      await store('rule', 'FREQ=DAILY;BYHOUR=3')
      await store('block', 'DTSTART:20260901T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO')

      // And a row whose zone was never stored, which is what `schedule({ tz: null })` wrote before
      // a falsy zone read as "none given".
      await db.executeSql(
        `INSERT INTO ${schema}.schedule (name, key, cron, timezone) VALUES ('sched_q', 'zoneless', '0 3 * * *', NULL)`)

      await contractor.migrate(40)
      expect(await contractor.schemaVersion()).toBe(currentSchemaVersion)

      const { rows } = await db.executeSql(`SELECT key, kind FROM ${schema}.schedule ORDER BY key`)
      expect(rows).toEqual([
        { key: 'block', kind: 'rrule' },
        { key: 'nightly', kind: 'cron' },
        { key: 'rule', kind: 'rrule' },
        { key: 'zoneless', kind: 'cron' }
      ])

      // The zone a row never carried. Nothing chose it: schedule()'s default is UTC and the docs
      // say UTC, but a destructuring default only covers `undefined`, so `schedule({ tz: null })`
      // left the column null and cron-parser then evaluated the row in the local zone of whichever
      // instance took the pass. The backfill is what makes Schedule.timezone the string its type
      // says it is.
      const { rows: zones } = await db.executeSql(`SELECT count(*)::int as nulls FROM ${schema}.schedule WHERE timezone IS NULL`)
      expect(zones[0].nulls).toBe(0)

      const { rows: backfilled } = await db.executeSql(`SELECT timezone FROM ${schema}.schedule WHERE key = 'zoneless'`)
      expect(backfilled[0].timezone).toBe('UTC')

      // And the kind a row cannot be: the column carries the two formats pg-boss evaluates, so a
      // value nothing reads is refused rather than stored and silently treated as cron.
      await expect(db.executeSql(
        `INSERT INTO ${schema}.schedule (name, key, kind, cron, timezone) VALUES ('sched_q', 'x', 'crontab', '0 3 * * *', 'UTC')`
      )).rejects.toThrow(/schedule_kind_check/)
    } finally {
      await db.close()
    }
  })

  it('patch upgrade from schema 35 carries only the bam default — no job-index churn (issue #832)', function () {
    // A database already past v33 (schema 35) upgrading to 36 runs only v36, which carries the
    // bam.created_on default change and NO index work. So it never re-drops/rebuilds its existing
    // job_i5/job_i9 — the slim job_i5 it already has stays put. The index fix lives in v33, which only
    // pre-v33 (deadlock-affected) databases run.
    const sql = next('custom', 35)
    expect(sql).toContain('ALTER TABLE custom.bam ALTER COLUMN created_on SET DEFAULT clock_timestamp()')
    expect(sql).not.toContain('job_i9')
    expect(sql).not.toContain('job_i5')
    expect(sql).not.toMatch(/job_table_run_async\(/)
  })

  itPostgresOnly('should remove indexes created on the job table that follow the standard naming convention', async function () {
    const config = { ...ctx.bossConfig }
    const schema = config.schema

    // Get all real migrations
    config.migrations = getAllForConfig(config)

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

  // Walks every migration down and back up, waiting on BAM index builds at each end, so its cost
  // grows with the migration list — it was already landing at 8-10s against the 10s default before
  // schema v39, and tipped over under the contention of a full parallel run. Budgeted explicitly
  // rather than left to tip again on the next schema bump.
  itPostgresOnly('should have identical schema after rolling back all migrations and replaying them', { timeout: 60000 }, async function () {
    const config = { ...ctx.bossConfig }
    const schema = config.schema

    config.migrations = getAllForConfig(config)

    const db = await getDb()
    // @ts-ignore
    const contractor = new Contractor(db, config)

    // Helper function to wait for BAM completion
    // The budget tracks the migration list: v40 replaces the fetch index with a build-then-retire
    // pair per job table, so a full rollback-and-replay drains noticeably more BAM commands than it
    // did at v39 and the old 10s default started tipping under the contention of a parallel run.
    const waitForBamCompletion = async (boss: PgBoss, timeoutMs = 30000): Promise<void> => {
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
      const sql = migrate(schema, 0, undefined, undefined, {
        inlineAsync: true,
        partitionTables: [{ tableName: 'jABC', policy: 'standard' }]
      })

      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS job_common_i7 ON ${schema}.job_common`)
      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS jABC_i7 ON ${schema}.jABC`)
      expect(sql).toContain(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS job_common_i8 ON ${schema}.job_common`)
      // i8 is not fanned out across partitions
      expect(sql).not.toContain('jABC_i8')
    })

    it('should build i10 only for key_strict_fifo partitions', function () {
      const sql = migrate(schema, 37, undefined, undefined, {
        inlineAsync: true,
        partitionTables: [
          { tableName: 'strict_table', policy: 'key_strict_fifo' },
          { tableName: 'standard_table', policy: 'standard' }
        ]
      })

      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS strict_table_i10 ON ${schema}.strict_table`)
      expect(sql).not.toContain('standard_table_i10')
    })

    it('should reject the removed string[] partitionTables shape', function () {
      // TypeScript callers get a compile error; this pins the runtime error a JavaScript caller
      // still on the pre-12.28.0 shape sees, instead of a silently wrong target list.
      expect(() => migrate(schema, 37, undefined, undefined, {
        inlineAsync: true,
        // @ts-expect-error deliberately passing the removed string[] shape
        partitionTables: ['strict_table']
      })).toThrow(/must be \{ tableName, policy \} records/)
    })

    it('should keep using job_table_run_async (BAM) for the live migration path', function () {
      const sql = migrate(schema, 0)

      expect(sql).toMatch(enqueueCall)
      // The live path enqueues to BAM; it never renders the inlined direct DDL (whose provenance
      // comment is the unambiguous marker). The CONCURRENTLY text itself now appears inside the
      // enqueued job_table_run_async() command bodies, so it can't distinguish the paths.
      expect(sql).not.toContain('-- inlined from')
    })

    itPostgresOnly('should create job_common i7/i8 via the inlined path without a BAM worker', async function () {
      const config = { ...ctx.bossConfig }
      const dbSchema = config.schema
      config.migrations = getAllForConfig(config)

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

    it('should enqueue an unscoped async command when it names no partition policy', function () {
      // An AsyncMigrationCommand without partitionPolicy fans out to every job table rather than to
      // the partitions of one policy, so it enqueues the two-argument form and lets
      // job_table_run_async() do the fan-out itself. Every command in the store happens to name a
      // policy today, so this shape is only reachable through a supplied migration.
      const migrations = [{
        release: '99.0.0',
        version: 99,
        previous: 98,
        install: ['SELECT 1'],
        async: [{ name: 'unscoped_build', command: 'CREATE INDEX CONCURRENTLY job_i99 ON job (id)' }],
        uninstall: ['SELECT 1']
      }]

      const { sql, concurrent } = migrateCommands(schema, 98, migrations, false)

      expect(sql).toContain(`SELECT ${schema}.job_table_run_async('unscoped_build', 99, $$CREATE INDEX CONCURRENTLY job_i99 ON job (id)$$)`)
      // No queue_name/table_name arguments: those belong to the policy-scoped form.
      expect(sql).not.toContain('queue_name')
      expect(concurrent).toEqual([])
    })

    it('should forward partitionTables from getMigrationPlans through to the inlined builds', function () {
      const sql = getMigrationPlans(schema, 0, {
        partitionTables: [{ tableName: 'jXYZ', policy: 'standard' }]
      })

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
      const partitionTables = result.rows.map((row: { table_name: string, policy: 'standard' }) => ({
        tableName: row.table_name,
        policy: row.policy
      }))
      await db.close()

      // the partitioned queue gets its own table; the shared job_common is not partition = true
      expect(partitionTables.length).toBeGreaterThan(0)
      expect(partitionTables.map(partition => partition.tableName)).not.toContain('job_common')

      // feeding those tables in fans i7 out across each partition, exactly as `pg-boss migrate` does
      const sql = migrate(dbSchema, 0, undefined, undefined, { inlineAsync: true, partitionTables })

      for (const partition of partitionTables) {
        expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${partition.tableName}_i7 ON ${dbSchema}.${partition.tableName}`)
      }
    })
  })

  it('v42 adds the schema clock function and leaves the timestamp defaults on pg_catalog', async function () {
    await contractor.create()

    const { schema } = ctx.bossConfig
    const db = await getDb()

    // Every default that reads the clock. bam.created_on uses clock_timestamp() on purpose and is
    // excluded by the LIKE pattern.
    const clockDefaults = async () => (await db.executeSql(`
      SELECT table_name, column_name, column_default
        FROM information_schema.columns
       WHERE table_schema = $1
         AND column_default LIKE '%now()%'
       ORDER BY table_name, column_name`, [schema])).rows as Array<{ table_name: string, column_name: string, column_default: string }>

    const clockSource = async (): Promise<string | undefined> => (await db.executeSql(`
      SELECT p.prosrc
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = 'job_now'`, [schema])).rows[0]?.prosrc

    const hasClockFunction = async () => (await clockSource()) !== undefined

    // Fresh install: the function exists and no default reaches it, so DROP FUNCTION never has a
    // dependent (CockroachDB records one from create_queue() through the queue table's defaults).
    expect(await hasClockFunction()).toBe(true)
    // prosrc is stored verbatim, so the fresh body must equal the manifest's rendering byte for byte,
    // and the v42 step below must install exactly the same text.
    const manifestNow = schemaManifest.partitioned.functions.find(fn => fn.name === 'job_now')
    assertTruthy(manifestNow)
    const freshSource = await clockSource()
    expect(freshSource).toBe(extractFunctionBody(manifestNow.def))
    const fresh = await clockDefaults()
    expect(fresh.length).toBeGreaterThan(0)
    for (const row of fresh) {
      expect(row.column_default, `${row.table_name}.${row.column_name}`).not.toContain(`${schema}.job_now()`)
    }

    // Rolling v42 back drops the function and leaves the defaults alone.
    await contractor.rollback(currentSchemaVersion)
    expect(await hasClockFunction()).toBe(false)
    expect(await clockDefaults()).toEqual(fresh)

    // Migrating forward again lands on exactly the fresh-install shape.
    await contractor.migrate(currentSchemaVersion - 1)
    expect(await clockSource()).toBe(freshSource)
    expect(await clockDefaults()).toEqual(fresh)
  })
})
