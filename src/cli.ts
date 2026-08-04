#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Db from './db.ts'
import * as plans from './plans.ts'
import Contractor from './contractor.ts'
import * as migrationStore from './migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import type * as types from './types.ts'

const schemaVersion = packageJson.pgboss.schema as number

interface CliConfig {
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  connectionString?: string
  schema?: string
  ssl?: boolean | object
}

function printHelp (): void {
  console.log(`
pg-boss CLI v${packageJson.version}

Usage: pg-boss <command> [options]

Commands:
  migrate     Run pending migrations (creates schema if not exists)
  create      Create the pg-boss schema (initial installation)
  version     Show current schema version
  doctor      Check for schema/index drift against the expected shape
  plans       Output SQL plans without executing
  rollback    Rollback the last migration

Options:
  --help, -h              Show this help message
  --config, -c <file>     Path to config file (default: pgboss.json)
  --schema, -s <name>     Schema name (default: pgboss)
  --host <host>           Database host
  --port <port>           Database port
  --database, -d <name>   Database name
  --user, -u <user>       Database user
  --password, -p <pass>   Database password
  --connection-string     Full connection string (overrides other connection options)
  --ssl                   Enable SSL connection
  --dry-run               Output SQL without executing (for plans command)

Environment Variables:
  PGBOSS_DATABASE_URL     Full connection string
  PGBOSS_HOST             Database host
  PGBOSS_PORT             Database port
  PGBOSS_DATABASE         Database name
  PGBOSS_USER             Database user
  PGBOSS_PASSWORD         Database password
  PGBOSS_SCHEMA           Schema name (default: pgboss)

Config File (pgboss.json):
  {
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "postgres",
    "password": "secret",
    "schema": "pgboss",
    "ssl": false
  }

Examples:
  pg-boss migrate
  pg-boss migrate --schema my_schema
  pg-boss create --connection-string postgres://user:pass@localhost/db
  pg-boss plans migrate --dry-run
  pg-boss version
  PGBOSS_DATABASE_URL=postgres://localhost/mydb pg-boss migrate
`)
}

function loadConfigFile (configPath?: string): CliConfig {
  const paths = configPath
    ? [resolve(configPath)]
    : [
        resolve('pgboss.json'),
        resolve('.pgbossrc'),
        resolve('.pgbossrc.json')
      ]

  for (const filePath of paths) {
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8')
        const config = JSON.parse(content)
        console.log(`Loaded config from ${filePath}`)
        return config
      } catch (err: any) {
        console.error(`Error reading config file ${filePath}: ${err.message}`)
        process.exit(1)
      }
    }
  }

  return {}
}

function getConnectionConfig (args: ReturnType<typeof parseCliArgs>): types.DatabaseOptions {
  const fileConfig = loadConfigFile(args.config)

  const config: types.DatabaseOptions = {
    connectionString: args.connectionString || process.env.PGBOSS_DATABASE_URL || fileConfig.connectionString,
    host: args.host || process.env.PGBOSS_HOST || fileConfig.host,
    port: args.port ? parseInt(args.port, 10) : (process.env.PGBOSS_PORT ? parseInt(process.env.PGBOSS_PORT, 10) : fileConfig.port),
    database: args.database || process.env.PGBOSS_DATABASE || fileConfig.database,
    user: args.user || process.env.PGBOSS_USER || fileConfig.user,
    password: args.password || process.env.PGBOSS_PASSWORD || fileConfig.password,
    schema: args.schema || process.env.PGBOSS_SCHEMA || fileConfig.schema || plans.DEFAULT_SCHEMA
  }

  if (args.ssl || fileConfig.ssl) {
    config.ssl = args.ssl ? { rejectUnauthorized: false } : fileConfig.ssl
  }

  if (!config.connectionString && !config.host && !config.database) {
    console.error('Error: No database connection configured.')
    console.error('Provide connection via --connection-string, environment variables, or config file.')
    console.error('Run "pg-boss --help" for more information.')
    process.exit(1)
  }

  return config
}

function parseCliArgs () {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string', short: 'c' },
      schema: { type: 'string', short: 's' },
      host: { type: 'string' },
      port: { type: 'string' },
      database: { type: 'string', short: 'd' },
      user: { type: 'string', short: 'u' },
      password: { type: 'string', short: 'p' },
      'connection-string': { type: 'string' },
      ssl: { type: 'boolean' },
      'dry-run': { type: 'boolean' }
    },
    allowPositionals: true
  })

  return {
    help: values.help,
    config: values.config,
    schema: values.schema,
    host: values.host,
    port: values.port,
    database: values.database,
    user: values.user,
    password: values.password,
    connectionString: values['connection-string'],
    ssl: values.ssl,
    dryRun: values['dry-run'],
    command: positionals[0],
    subCommand: positionals[1]
  }
}

async function createDb (config: types.DatabaseOptions): Promise<Db> {
  const db = new Db(config)
  await db.open()
  return db
}

// Like getConnectionConfig, but returns null instead of exiting when no connection is
// configured — used by commands (e.g. `plans`) where a connection is optional.
function tryGetConnectionConfig (args: ReturnType<typeof parseCliArgs>): types.DatabaseOptions | null {
  const fileConfig = loadConfigFile(args.config)

  const hasConnection =
    args.connectionString || process.env.PGBOSS_DATABASE_URL || fileConfig.connectionString ||
    args.host || process.env.PGBOSS_HOST || fileConfig.host ||
    args.database || process.env.PGBOSS_DATABASE || fileConfig.database

  return hasConnection ? getConnectionConfig(args) : null
}

// Enumerates partitioned queue table names so inlined index builds can fan out across
// them. Returns [] on any failure (e.g. unreachable DB or pre-partition schema), leaving
// the export to target job_common only.
async function getPartitionTables (db: types.IDatabase, schema: string): Promise<string[]> {
  try {
    const result = await db.executeSql(plans.getPartitionedQueueTables(schema))
    return result.rows.map((row: { table_name: string }) => row.table_name)
  } catch {
    return []
  }
}

async function getSchemaVersion (db: types.IDatabase, schema: string): Promise<number | null> {
  try {
    const result = await db.executeSql(plans.versionTableExists(schema))
    if (!result.rows[0].name) {
      return null
    }
    const versionResult = await db.executeSql(plans.getVersion(schema))
    return versionResult.rows.length ? parseInt(versionResult.rows[0].version) : null
  } catch {
    return null
  }
}

async function cmdVersion (args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const config = getConnectionConfig(args)
  const schema = config.schema || plans.DEFAULT_SCHEMA
  const db = await createDb(config)

  try {
    const version = await getSchemaVersion(db, schema)
    if (version === null) {
      console.log(`pg-boss is not installed in schema "${schema}"`)
    } else {
      console.log(`Current schema version: ${version}`)
      console.log(`Latest schema version: ${schemaVersion}`)
      if (version < schemaVersion) {
        console.log(`Migrations pending: ${schemaVersion - version}`)
      } else {
        console.log('Schema is up to date')
      }
    }
  } finally {
    await db.close()
  }
}

async function cmdCreate (args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const config = getConnectionConfig(args)
  const schema = config.schema || plans.DEFAULT_SCHEMA

  if (args.dryRun) {
    const sql = plans.create(schema, schemaVersion, { createSchema: true })
    console.log('-- SQL to create pg-boss schema:')
    console.log(sql)
    return
  }

  const db = await createDb(config)

  try {
    const version = await getSchemaVersion(db, schema)
    if (version !== null) {
      console.log(`pg-boss is already installed in schema "${schema}" at version ${version}`)
      return
    }

    console.log(`Creating pg-boss schema "${schema}"...`)
    const sql = plans.create(schema, schemaVersion, { createSchema: true })
    await db.executeSql(sql)
    console.log(`Successfully created pg-boss schema "${schema}" at version ${schemaVersion}`)
  } finally {
    await db.close()
  }
}

async function cmdMigrate (args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const config = getConnectionConfig(args)
  const schema = config.schema || plans.DEFAULT_SCHEMA

  if (args.dryRun) {
    // The CLI has no BAM worker, so inline the async index builds as direct DDL. Connect
    // (best effort) to read the DB's actual version and enumerate partitioned tables; fall back to
    // job_common only offline.
    let partitionTables: string[] = []
    let version: number | null = null
    try {
      const db = await createDb(config)
      try {
        partitionTables = await getPartitionTables(db, schema)
        version = await getSchemaVersion(db, schema)
      } finally {
        await db.close()
      }
    } catch {
      // no reachable database: emit a job_common-only static script
    }

    if (version !== null && version >= schemaVersion) {
      console.log(`-- pg-boss schema "${schema}" is already at version ${version} (latest: ${schemaVersion}); nothing to migrate.`)
      return
    }

    // Render from the DB's actual version so the printed SQL is exactly what `migrate` would run.
    // Offline (or not yet installed) we can't know it, so fall back to the oldest supported starting
    // version — the full chain — instead of a bogus "from 0" that fails on non-idempotent steps.
    const fromVersion = version ?? migrationStore.getMinVersion(schema)
    const sql = migrationStore.migrate(schema, fromVersion, undefined, undefined, { inlineAsync: true, partitionTables })
    console.log(`-- SQL to migrate pg-boss from version ${fromVersion} to ${schemaVersion}:`)
    console.log(sql)
    return
  }

  const db = await createDb(config)

  try {
    const version = await getSchemaVersion(db, schema)

    if (version === null) {
      console.log(`pg-boss is not installed. Creating schema "${schema}"...`)
      const sql = plans.create(schema, schemaVersion, { createSchema: true })
      await db.executeSql(sql)
      console.log(`Successfully created pg-boss schema "${schema}" at version ${schemaVersion}`)
      return
    }

    if (version >= schemaVersion) {
      console.log(`pg-boss schema "${schema}" is already at version ${version} (latest: ${schemaVersion})`)
      return
    }

    console.log(`Migrating pg-boss schema "${schema}" from version ${version} to ${schemaVersion}...`)
    // Inline the async index builds rather than enqueuing BAM rows that nothing will run
    // (the CLI exits without a worker); enumerate partitions so they are covered too.
    const partitionTables = await getPartitionTables(db, schema)
    const { sql, concurrent } = migrationStore.migrateCommands(schema, version, undefined, undefined, { inlineAsync: true, partitionTables })
    await db.executeSql(sql)
    // CONCURRENTLY index builds must run outside the migration transaction, one at a time.
    for (const statement of concurrent) {
      await db.executeSql(statement)
    }
    console.log(`Successfully migrated pg-boss schema "${schema}" to version ${schemaVersion}`)
  } finally {
    await db.close()
  }
}

async function cmdRollback (args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const config = getConnectionConfig(args)
  const schema = config.schema || plans.DEFAULT_SCHEMA

  const db = await createDb(config)

  try {
    const version = await getSchemaVersion(db, schema)

    if (version === null) {
      console.log(`pg-boss is not installed in schema "${schema}"`)
      return
    }

    if (version <= 1) {
      console.log('Cannot rollback: already at minimum version')
      return
    }

    if (args.dryRun) {
      const sql = migrationStore.rollback(schema, version)
      console.log(`-- SQL to rollback pg-boss from version ${version} to ${version - 1}:`)
      console.log(sql)
      return
    }

    console.log(`Rolling back pg-boss schema "${schema}" from version ${version} to ${version - 1}...`)
    const sql = migrationStore.rollback(schema, version)
    await db.executeSql(sql)
    console.log(`Successfully rolled back pg-boss schema "${schema}" to version ${version - 1}`)
  } finally {
    await db.close()
  }
}

async function cmdDoctor (args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const config = getConnectionConfig(args)
  const schema = config.schema || plans.DEFAULT_SCHEMA
  const db = await createDb(config)

  try {
    const version = await getSchemaVersion(db, schema)
    if (version === null) {
      console.log(`pg-boss is not installed in schema "${schema}"`)
      process.exitCode = 1
      return
    }

    console.log(`Schema "${schema}" version ${version} (latest: ${schemaVersion})`)
    if (version < schemaVersion) {
      console.log(`⚠ Migrations pending: ${schemaVersion - version} — run "pg-boss migrate" before trusting drift results`)
    }

    // Reuse the same drift scan the boss.detectSchemaDrift() API runs, rather than duplicating the
    // catalog queries + computeSchemaDrift wiring here (the two copies had already drifted apart and
    // carried divergent best-effort/backend-gating bugs). Contractor.detectDrift handles the
    // partitioned probe, best-effort catalog fallbacks, and backend-specific gating in one place.
    const contractor = new Contractor(db, { ...config, schema } as unknown as types.ResolvedConstructorOptions)
    const report = await contractor.detectDrift()

    if (report.building.length) {
      console.log(`\nBuilding (async index build in progress — not yet drift) (${report.building.length}):`)
      for (const i of report.building) console.log(`  ${i.table}.${i.name}`)
    }

    // Extra indexes are informational (a stale pg-boss index or a user-added one) — a warning, not
    // drift. Printed regardless of overall status; it never changes the exit code.
    if (report.extraIndexes.length) {
      console.log(`\n⚠ EXTRA INDEXES (present on a managed table but not expected — harmless) (${report.extraIndexes.length}):`)
      for (const i of report.extraIndexes) console.log(`  ${i.table}.${i.name}`)
    }

    if (report.ok) {
      console.log('\n✓ No drift detected')
      return
    }

    if (report.missingTables.length) {
      console.log(`\nMISSING TABLES (expected but absent) (${report.missingTables.length}):`)
      for (const t of report.missingTables) console.log(`  ${t}`)
    }

    // Each drifted index is printed with the expected (correct) definition and, where one exists, the
    // actual definition beneath it, for a direct side-by-side comparison and copy-paste remediation.
    if (report.missing.length) {
      console.log(`\nMISSING (expected but absent) (${report.missing.length}):`)
      for (const i of report.missing) {
        console.log(`  ${i.table}.${i.name}`)
        if (i.definition) console.log(`    expected: ${i.definition}`)
      }
    }

    if (report.invalid.length) {
      // The definition is correct — the index is just invalid (interrupted build) — so show the DDL to
      // drop and rebuild it, not an expected-vs-actual comparison (they would be identical).
      console.log(`\nINVALID (present but marked invalid — drop and rebuild) (${report.invalid.length}):`)
      for (const i of report.invalid) {
        console.log(`  ${i.table}.${i.name}`)
        if (i.definition) console.log(`    rebuild: ${i.definition}`)
      }
    }

    if (report.mismatched.length) {
      console.log(`\nMISMATCHED (definition differs) (${report.mismatched.length}):`)
      for (const m of report.mismatched) {
        console.log(`  ${m.table}.${m.name} [${m.differs.join(', ')}]`)
        if (m.definition) console.log(`    expected: ${m.definition}`)
        console.log(`    actual:   ${m.actualDefinition}`)
      }
    }

    if (report.missingFunctions.length) {
      console.log(`\nMISSING FUNCTIONS (expected but absent) (${report.missingFunctions.length}):`)
      for (const f of report.missingFunctions) {
        console.log(`  ${f.name}`)
        console.log(`    expected: ${f.definition}`)
      }
    }

    if (report.mismatchedFunctions.length) {
      console.log(`\nMISMATCHED FUNCTIONS (body differs) (${report.mismatchedFunctions.length}):`)
      for (const f of report.mismatchedFunctions) {
        console.log(`  ${f.name}`)
        console.log(`    expected: ${f.definition}`)
        console.log(`    actual:   ${f.actualDefinition}`)
      }
    }

    if (report.columnDrift.length) {
      console.log(`\nCOLUMN DRIFT (missing/unexpected columns, or default/type/nullability drift) (${report.columnDrift.length}):`)
      for (const c of report.columnDrift) {
        console.log(`  ${c.table}`)
        if (c.missingColumns.length) console.log(`    missing:    ${c.missingColumns.join(', ')}`)
        if (c.unexpectedColumns.length) console.log(`    unexpected: ${c.unexpectedColumns.join(', ')}`)
        for (const d of c.defaultMismatches) console.log(`    default ${d.column}: expected ${d.expected}, actual ${d.actual}`)
        for (const d of c.typeMismatches) console.log(`    type ${d.column}: expected ${d.expected}, actual ${d.actual}`)
        for (const d of c.nullabilityMismatches) console.log(`    nullability ${d.column}: expected ${d.expected ? 'NOT NULL' : 'nullable'}, actual ${d.actual ? 'NOT NULL' : 'nullable'}`)
      }
    }

    if (report.constraintDrift.length) {
      console.log(`\nCONSTRAINT DRIFT (missing or unexpected constraints) (${report.constraintDrift.length}):`)
      for (const c of report.constraintDrift) {
        console.log(`  ${c.table}`)
        if (c.missingConstraints.length) for (const d of c.missingConstraints) console.log(`    missing:    ${d}`)
        if (c.unexpectedConstraints.length) for (const d of c.unexpectedConstraints) console.log(`    unexpected: ${d}`)
      }
    }

    if (report.enumDrift) {
      const e = report.enumDrift
      console.log('\nENUM DRIFT (value set/order differs):')
      console.log(`  ${e.name}`)
      console.log(`    expected: ${e.expectedValues.join(', ')}`)
      console.log(`    actual:   ${e.actualValues.join(', ')}`)
    }

    console.log('\n✗ Schema drift detected')
    process.exitCode = 1
  } finally {
    await db.close()
  }
}

async function cmdPlans (args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const fileConfig = loadConfigFile(args.config)
  const schema = args.schema || process.env.PGBOSS_SCHEMA || fileConfig.schema || plans.DEFAULT_SCHEMA
  const subCommand = args.subCommand || 'migrate'

  switch (subCommand) {
    case 'create':
    case 'construct':
      console.log('-- SQL to create pg-boss schema:')
      console.log(plans.create(schema, schemaVersion, { createSchema: true }))
      break

    case 'migrate': {
      // Inline the async index builds (no BAM worker runs an exported script). A connection
      // is optional: with one, fan the builds out across partitioned tables; without one,
      // emit a job_common-only script and note the limitation.
      const connectionConfig = tryGetConnectionConfig(args)
      let partitionTables: string[] = []

      if (connectionConfig) {
        try {
          const db = await createDb(connectionConfig)
          try {
            partitionTables = await getPartitionTables(db, schema)
          } finally {
            await db.close()
          }
        } catch {
          // unreachable database: fall back to a job_common-only script
        }
      }

      console.log('-- SQL to migrate pg-boss (from version 0 to latest):')
      if (!connectionConfig) {
        console.log('-- note: no database connection provided; partitioned queue tables were not enumerated.')
        console.log('-- Run with a connection (e.g. --connection-string) to include per-partition index builds.')
      }
      console.log(migrationStore.migrate(schema, 0, undefined, undefined, { inlineAsync: true, partitionTables }))
      break
    }

    case 'rollback':
      console.log(`-- SQL to rollback pg-boss from version ${schemaVersion} to ${schemaVersion - 1}:`)
      console.log(migrationStore.rollback(schema, schemaVersion))
      break

    default:
      console.error(`Unknown plans subcommand: ${subCommand}`)
      console.error('Available: create, migrate, rollback')
      process.exit(1)
  }
}

async function main (): Promise<void> {
  const args = parseCliArgs()

  if (args.help || !args.command) {
    printHelp()
    process.exit(0)
  }

  try {
    switch (args.command) {
      case 'version':
        await cmdVersion(args)
        break

      case 'doctor':
        await cmdDoctor(args)
        break

      case 'create':
        await cmdCreate(args)
        break

      case 'migrate':
        await cmdMigrate(args)
        break

      case 'rollback':
        await cmdRollback(args)
        break

      case 'plans':
        await cmdPlans(args)
        break

      default:
        console.error(`Unknown command: ${args.command}`)
        console.error('Run "pg-boss --help" for available commands.')
        process.exit(1)
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    if (process.env.DEBUG) {
      console.error(err.stack)
    }
    process.exit(1)
  }
}

main()
