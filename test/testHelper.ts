import Db from '../src/db.ts'
import { PgBoss } from '../src/index.ts'
import crypto from 'node:crypto'
import configJson from './config.json' with { type: 'json' }
import type { ConstructorOptions } from '../src/types.ts'
import { getColumns, getConstraints, getIndexes, getFunctions } from './pgSchemaHelper.ts'

const sha1 = (value: string): string => crypto.createHash('sha1').update(value).digest('hex')

function assertTruthy<T> (value: T, message?: string): asserts value is NonNullable<T> {
  if (value == null) {
    throw new Error(message ?? 'Expected value to be defined')
  }
}

function getConnectionString (): string {
  const config = getConfig()

  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
}

function getConfig (options: Partial<ConstructorOptions> & { testKey?: string } = {}): ConstructorOptions {
  const config: any = { ...configJson }

  config.host = process.env.POSTGRES_HOST || config.host
  config.port = process.env.POSTGRES_PORT || config.port
  config.password = process.env.POSTGRES_PASSWORD || config.password

  if (options.testKey) {
    config.schema = `pgboss${sha1(options.testKey)}`
  }

  config.schema = config.schema || 'pgboss'

  config.supervise = false
  config.schedule = false
  config.createSchema = true

  return Object.assign(config, options)
}

async function init (): Promise<void> {
  const { database } = getConfig()

  assertTruthy(database)
  await tryCreateDb(database)
}

async function getDb ({ database, debug }: { database?: string; debug?: boolean } = {}): Promise<Db> {
  const config = getConfig()

  config.database = database || config.database

  const db = new Db({ ...config, debug })

  await db.open()

  return db
}

async function dropSchema (schema: string): Promise<void> {
  const db = await getDb()
  await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await db.close()
}

async function findJobs (schema: string, where: string, values?: any[]): Promise<any> {
  const db = await getDb()
  const jobs = await db.executeSql(`select * from ${schema}.job where ${where}`, values)
  await db.close()
  return jobs
}

async function countJobs (schema: string, table: string, where: string, values?: any[]): Promise<number> {
  const db = await getDb()
  const result = await db.executeSql(`select count(*) as count from ${schema}.${table} where ${where}`, values)
  await db.close()
  return parseFloat(result.rows[0].count)
}

async function tryCreateDb (database: string): Promise<void> {
  const db = await getDb({ database: 'postgres' })

  try {
    await db.executeSql(`CREATE DATABASE ${database}`)
  } catch {} finally {
    await db.close()
  }
}

async function start (options?: Partial<ConstructorOptions> & { testKey?: string; noDefault?: boolean }): Promise<PgBoss> {
  try {
    const config = getConfig(options)

    const boss = new PgBoss(config)
    // boss.on('error', err => console.log({ schema: config.schema, message: err.message }))

    await boss.start()

    if (!options?.noDefault) {
      assertTruthy(config.schema)
      await boss.createQueue(config.schema)
    }
    return boss
  } catch (err) {
    // this is nice for occaisional debugging, Mr. Linter
    if (err) {
      throw err
    }
    throw new Error('Unexpected error')
  }
}

async function getSchemaDefs (schemas: string[]) {
  const columnsSql = getColumns(schemas)
  const indexeSql = getIndexes(schemas)
  const constraintsSql = getConstraints(schemas)
  const functionsSql = getFunctions(schemas)

  const db = await getDb()

  const [columns, indexes, constraints, functions] = await Promise.all([
    db.executeSql(columnsSql),
    db.executeSql(indexeSql),
    db.executeSql(constraintsSql),
    db.executeSql(functionsSql)
  ])

  await db.close()

  return { columns, indexes, constraints, functions }
}

export {
  assertTruthy,
  dropSchema,
  start,
  getDb,
  countJobs,
  findJobs,
  getConfig,
  getConnectionString,
  tryCreateDb,
  init,
  getSchemaDefs
}
