import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { execCommand } from 'cli-testlab'
import { resolve } from 'node:path'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { getConnectionString, dropSchema, getDb } from './testHelper.ts'

const cliPath = resolve(import.meta.dirname, '../src/cli.ts')
const sha1 = (value: string): string => crypto.createHash('sha1').update(value).digest('hex')

function getTestSchema (testName: string): string {
  return `pgboss${sha1('cliTest' + testName)}`
}

describe('cli', function () {
  describe('help', function () {
    it('should show help with --help flag', async function () {
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'pg-boss CLI'
      })
    })

    it('should show help with -h flag', async function () {
      await execCommand(`node ${cliPath} -h`, {
        expectedOutput: 'Usage: pg-boss <command>'
      })
    })

    it('should show help when no command provided', async function () {
      await execCommand(`node ${cliPath}`, {
        expectedOutput: 'Commands:'
      })
    })

    it('should list all available commands in help', async function () {
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'migrate'
      })
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'create'
      })
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'version'
      })
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'plans'
      })
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'rollback'
      })
    })

    it('should show environment variables documentation', async function () {
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'PGBOSS_DATABASE_URL'
      })
      await execCommand(`node ${cliPath} --help`, {
        expectedOutput: 'PGBOSS_HOST'
      })
    })
  })

  describe('plans', function () {
    it('should output create SQL plans', async function () {
      await execCommand(`node ${cliPath} plans create`, {
        expectedOutput: 'CREATE SCHEMA'
      })
    })

    it('should output migrate SQL plans', async function () {
      await execCommand(`node ${cliPath} plans migrate`, {
        expectedOutput: 'SQL to migrate'
      })
    })

    it('should output rollback SQL plans', async function () {
      await execCommand(`node ${cliPath} plans rollback`, {
        expectedOutput: 'SQL to rollback'
      })
    })

    it('should use custom schema in plans', async function () {
      await execCommand(`node ${cliPath} plans create --schema custom_schema`, {
        expectedOutput: 'custom_schema'
      })
    })

    it('should error on unknown plans subcommand', async function () {
      await execCommand(`node ${cliPath} plans unknown`, {
        expectedErrorMessage: 'Unknown plans subcommand'
      })
    })
  })

  describe('error handling', function () {
    it('should error when no database connection configured', async function () {
      await execCommand(`node ${cliPath} migrate`, {
        expectedErrorMessage: 'No database connection configured'
      })
    })

    it('should error on unknown command', async function () {
      // Use plans command context since unknown command check happens before connection
      await execCommand(`node ${cliPath} unknowncommand`, {
        expectedErrorMessage: 'Unknown command'
      })
    })
  })

  describe('config file', function () {
    const configPath = resolve(import.meta.dirname, 'test-pgboss.json')

    afterEach(function () {
      if (existsSync(configPath)) {
        unlinkSync(configPath)
      }
    })

    it('should load config from specified file', async function () {
      const config = {
        host: '127.0.0.1',
        port: 5432,
        database: 'pgboss',
        user: 'postgres',
        password: 'postgres',
        schema: 'test_config_schema'
      }
      writeFileSync(configPath, JSON.stringify(config))

      await execCommand(`node ${cliPath} plans create --config ${configPath}`, {
        expectedOutput: 'test_config_schema'
      })
    })

    it('should report when config file is loaded', async function () {
      const config = {
        host: 'localhost',
        database: 'testdb'
      }
      writeFileSync(configPath, JSON.stringify(config))

      await execCommand(`node ${cliPath} plans create --config ${configPath}`, {
        expectedOutput: 'Loaded config from'
      })
    })
  })

  describe('database operations', function () {
    const connectionString = getConnectionString()

    describe('version', function () {
      const schema = getTestSchema('version')

      beforeEach(async function () {
        await dropSchema(schema)
      })

      afterEach(async function () {
        await dropSchema(schema)
      })

      it('should report when pg-boss is not installed', async function () {
        await execCommand(
          `node ${cliPath} version --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'not installed' }
        )
      })

      it('should report current version after installation', async function () {
        // First create the schema
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        // Then check version
        await execCommand(
          `node ${cliPath} version --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Current schema version' }
        )
      })
    })

    describe('create', function () {
      const schema = getTestSchema('create')

      beforeEach(async function () {
        await dropSchema(schema)
      })

      afterEach(async function () {
        await dropSchema(schema)
      })

      it('should create pg-boss schema', async function () {
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )
      })

      it('should report if schema already exists', async function () {
        // Create first time
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        // Try to create again
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'already installed' }
        )
      })

      it('should support dry-run mode', async function () {
        const result = await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema} --dry-run`
        )
        expect(result.stdout).toContain('SQL to create')

        // Verify schema was not actually created
        await execCommand(
          `node ${cliPath} version --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'not installed' }
        )
      })
    })

    describe('migrate', function () {
      const schema = getTestSchema('migrate')

      beforeEach(async function () {
        await dropSchema(schema)
      })

      afterEach(async function () {
        await dropSchema(schema)
      })

      it('should create schema if not exists during migrate', async function () {
        await execCommand(
          `node ${cliPath} migrate --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )
      })

      it('should report when already at latest version', async function () {
        // First create the schema
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        // Then try to migrate
        await execCommand(
          `node ${cliPath} migrate --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'already at version' }
        )
      })

      it('should support dry-run mode', async function () {
        const result = await execCommand(
          `node ${cliPath} migrate --connection-string ${connectionString} --schema ${schema} --dry-run`
        )
        expect(result.stdout).toContain('SQL to migrate')
      })
    })

    describe('rollback', function () {
      const schema = getTestSchema('rollback')

      beforeEach(async function () {
        await dropSchema(schema)
      })

      afterEach(async function () {
        await dropSchema(schema)
      })

      it('should report when pg-boss is not installed', async function () {
        await execCommand(
          `node ${cliPath} rollback --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'not installed' }
        )
      })

      it('should rollback last migration', async function () {
        // First create the schema
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        // Then rollback
        await execCommand(
          `node ${cliPath} rollback --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully rolled back' }
        )
      })

      it('should support dry-run mode for rollback', async function () {
        // First create the schema
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        // Get version before
        const db = await getDb()
        const beforeResult = await db.executeSql(`SELECT version FROM ${schema}.version`)
        const versionBefore = beforeResult.rows[0].version

        // Dry run rollback
        const result = await execCommand(
          `node ${cliPath} rollback --connection-string ${connectionString} --schema ${schema} --dry-run`
        )
        expect(result.stdout).toContain('SQL to rollback')

        // Verify version unchanged
        const afterResult = await db.executeSql(`SELECT version FROM ${schema}.version`)
        const versionAfter = afterResult.rows[0].version
        await db.close()

        expect(versionBefore).toBe(versionAfter)
      })
    })

    describe('environment variables', function () {
      const schema = getTestSchema('env')

      beforeEach(async function () {
        await dropSchema(schema)
      })

      afterEach(async function () {
        await dropSchema(schema)
      })

      it('should read connection from PGBOSS_DATABASE_URL env var', async function () {
        await execCommand(`node ${cliPath} version`, {
          env: { PGBOSS_DATABASE_URL: connectionString, PGBOSS_SCHEMA: schema },
          expectedOutput: 'not installed'
        })
      })

      it('should read schema from PGBOSS_SCHEMA env var', async function () {
        await execCommand(`node ${cliPath} plans create`, {
          env: { PGBOSS_DATABASE_URL: connectionString, PGBOSS_SCHEMA: 'env_test_schema' },
          expectedOutput: 'env_test_schema'
        })
      })
    })

    describe('connection options', function () {
      const schema = getTestSchema('conn')

      beforeEach(async function () {
        await dropSchema(schema)
      })

      afterEach(async function () {
        await dropSchema(schema)
      })

      it('should connect using individual connection parameters', async function () {
        await execCommand(
          `node ${cliPath} version --host 127.0.0.1 --port 5432 --database pgboss --user postgres --password postgres --schema ${schema}`,
          { expectedOutput: 'not installed' }
        )
      })

      it('should connect using short options', async function () {
        await execCommand(
          `node ${cliPath} version --host 127.0.0.1 -d pgboss -u postgres -p postgres -s ${schema}`,
          { expectedOutput: 'not installed' }
        )
      })
    })

    describe('schema structure validation', function () {
      const schema = getTestSchema('structure')

      beforeEach(async function () {
        await dropSchema(schema)
      })

      afterEach(async function () {
        await dropSchema(schema)
      })

      it('should create all required tables and types', async function () {
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        const db = await getDb()

        // Check tables exist
        const tablesResult = await db.executeSql(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = '${schema}'
        `)
        const tables = tablesResult.rows.map((r: { table_name: string }) => r.table_name)
        expect(tables).toContain('version')
        expect(tables).toContain('queue')
        expect(tables).toContain('job')
        expect(tables).toContain('job_common')

        // Check job_state enum exists with expected values
        const enumResult = await db.executeSql(`
          SELECT enumlabel
          FROM pg_enum e
          JOIN pg_type t ON e.enumtypid = t.oid
          WHERE t.typname = 'job_state'
            AND t.typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}')
          ORDER BY e.enumsortorder
        `)
        const enumValues = enumResult.rows.map((r: { enumlabel: string }) => r.enumlabel)
        expect(enumValues).toEqual(['created', 'retry', 'active', 'completed', 'cancelled', 'failed'])

        // Check functions exist
        const functionsResult = await db.executeSql(`
          SELECT routine_name
          FROM information_schema.routines
          WHERE routine_schema = '${schema}'
        `)
        const functions = functionsResult.rows.map((r: { routine_name: string }) => r.routine_name)
        expect(functions).toContain('create_queue')
        expect(functions).toContain('delete_queue')

        await db.close()
      })

      it('should set correct schema version', async function () {
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        const db = await getDb()
        const result = await db.executeSql(`SELECT version FROM ${schema}.version`)
        await db.close()

        expect(result.rows[0].version).toBe(27)
      })

      it('should decrement schema version after rollback', async function () {
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        const db = await getDb()
        const beforeResult = await db.executeSql(`SELECT version FROM ${schema}.version`)
        const versionBefore = beforeResult.rows[0].version

        await execCommand(
          `node ${cliPath} rollback --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully rolled back' }
        )

        const afterResult = await db.executeSql(`SELECT version FROM ${schema}.version`)
        const versionAfter = afterResult.rows[0].version
        await db.close()

        expect(versionAfter).toBe(versionBefore - 1)
      })

      it('should create job table as partitioned with job_common as default partition', async function () {
        await execCommand(
          `node ${cliPath} create --connection-string ${connectionString} --schema ${schema}`,
          { expectedOutput: 'Successfully created' }
        )

        const db = await getDb()

        // Check job is a partitioned table
        const partitionResult = await db.executeSql(`
          SELECT c.relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${schema}' AND c.relname = 'job'
        `)
        expect(partitionResult.rows[0].relkind).toBe('p')

        // Check job_common is attached as partition
        const inheritResult = await db.executeSql(`
          SELECT child.relname
          FROM pg_inherits
          JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
          JOIN pg_class child ON pg_inherits.inhrelid = child.oid
          JOIN pg_namespace n ON parent.relnamespace = n.oid
          WHERE n.nspname = '${schema}' AND parent.relname = 'job'
        `)
        expect(inheritResult.rows.map((r: { relname: string }) => r.relname)).toContain('job_common')

        await db.close()
      })
    })
  })
})
