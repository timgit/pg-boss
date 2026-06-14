#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Db from './db.ts'
import * as plans from './plans.ts'
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
    const sql = migrationStore.migrate(schema, 0)
    console.log('-- SQL to migrate pg-boss from version 0 to latest:')
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
    const sql = migrationStore.migrate(schema, version)
    await db.executeSql(sql)
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

    case 'migrate':
      console.log('-- SQL to migrate pg-boss (from version 0 to latest):')
      console.log(migrationStore.migrate(schema, 0))
      break

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
