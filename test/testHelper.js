import { createHash } from 'node:crypto'
import Db from '../src/db.js'
import PgBoss from '../src/index.js'
import config from './config.json'

const sha1 = (value) => createHash('sha1').update(value).digest('hex')

export function getConnectionString () {
  const config = getConfig()

  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
}

export function getConfig (options = {}) {
  config.host = process.env.POSTGRES_HOST || config.host
  config.port = process.env.POSTGRES_PORT || config.port
  config.password = process.env.POSTGRES_PASSWORD || config.password

  if (options.testKey) {
    config.schema = `pgboss${sha1(options.testKey)}`
  }

  config.schema = config.schema || 'pgboss'

  config.supervise = false
  config.schedule = false
  config.retryLimit = 0

  const result = { ...config }

  return Object.assign(result, options)
}

export async function init () {
  const { database } = getConfig()

  await tryCreateDb(database)
}

export async function getDb ({ database, debug } = {}) {
  const config = getConfig()

  config.database = database || config.database

  const db = new Db({ ...config, debug })

  await db.open()

  return db
}

export async function dropSchema (schema) {
  const db = await getDb()
  await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await db.close()
}

export async function findJobs (schema, where, values) {
  const db = await getDb()
  const jobs = await db.executeSql(`select * from ${schema}.job where ${where}`, values)
  await db.close()
  return jobs
}

export async function countJobs (schema, table, where, values) {
  const db = await getDb()
  const result = await db.executeSql(`select count(*) as count from ${schema}.${table} where ${where}`, values)
  await db.close()
  return parseFloat(result.rows[0].count)
}

async function tryCreateDb (database) {
  const db = await getDb({ database: 'postgres' })

  try {
    await db.executeSql(`CREATE DATABASE ${database}`)
  } catch {
  } finally {
    await db.close()
  }
}

export async function start (options) {
  try {
    options = getConfig(options)
    const boss = new PgBoss(options)
    // boss.on('error', err => console.log({ schema: options.schema, message: err.message }))
    await boss.start()
    // auto-create queue for tests
    if (!options.noDefault) {
      await boss.createQueue(options.schema)
    }
    return boss
  } catch (err) {
    // this is nice for occaisional debugging, Mr. Linter
    if (err) {
      throw err
    }
  }
}
