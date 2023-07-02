const Db = require('../src/db')
const PgBoss = require('../')
const plans = require('../src/plans')
const { COMPLETION_JOB_PREFIX } = plans
const crypto = require('crypto')
const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex')

module.exports = {
  dropSchema,
  start,
  stop,
  getDb,
  getArchivedJobById,
  countJobs,
  findJobs,
  COMPLETION_JOB_PREFIX,
  getConfig,
  getConnectionString,
  tryCreateDb,
  init
}

function getConnectionString () {
  const config = getConfig()

  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
}

function getConfig (options = {}) {
  const config = require('./config.json')

  config.host = process.env.POSTGRES_HOST || config.host
  config.port = process.env.POSTGRES_PORT || config.port
  config.password = process.env.POSTGRES_PASSWORD || config.password

  if (options.testKey) {
    config.schema = `pgboss${sha1(options.testKey).slice(-10)}`
  }

  config.schema = config.schema || 'pgboss'

  const result = { ...config }

  return Object.assign(result, options)
}

async function init () {
  const { database } = getConfig()

  await tryCreateDb(database)
  await createPgCrypto(database)
}

async function getDb (database) {
  const config = getConfig()

  config.database = database || config.database

  const db = new Db(config)

  await db.open()

  return db
}

async function createPgCrypto (database) {
  const db = await getDb(database)
  await db.executeSql('create extension if not exists pgcrypto')
  await db.close()
}

async function dropSchema (schema) {
  const db = await getDb()
  await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await db.close()
}

async function findJobs (schema, where, values) {
  const db = await getDb()
  const jobs = await db.executeSql(`select * from ${schema}.job where ${where}`, values)
  await db.close()
  return jobs
}

async function getArchivedJobById (schema, id) {
  const response = await findArchivedJobs(schema, 'id = $1', [id])
  return response.rows.length ? response.rows[0] : null
}

async function findArchivedJobs (schema, where, values) {
  const db = await getDb()
  const result = await db.executeSql(`select * from ${schema}.archive where ${where}`, values)
  await db.close()
  return result
}

async function countJobs (schema, where, values) {
  const db = await getDb()
  const result = await db.executeSql(`select count(*) as count from ${schema}.job where ${where}`, values)
  await db.close()
  return parseFloat(result.rows[0].count)
}

async function tryCreateDb (database) {
  const db = await getDb('postgres')

  try {
    await db.executeSql(`CREATE DATABASE ${database}`)
  } catch {} finally {
    await db.close()
  }
}

async function start (options) {
  try {
    options = getConfig(options)
    const boss = new PgBoss(options)
    boss.on('error', err => console.log({ schema: options.schema, message: err.message }))
    await boss.start()
    return boss
  } catch (err) {
    // this is nice for occaisional debugging, Mr. Linter
    if (err) {
      throw err
    }
  }
}

async function stop (boss, timeout = 4000) {
  await boss.stop({ timeout })
}
