const Db = require('../src/db')
const PgBoss = require('../')
const plans = require('../src/plans')
const crypto = require('crypto')
const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex')

module.exports = {
  dropSchema,
  start,
  getDb,
  getJobById,
  getArchivedJobById,
  countJobs,
  completedJobPrefix: plans.completedJobPrefix,
  getConfig,
  getConnectionString
}

function getConnectionString () {
  const config = getConfig()

  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
}

function getConfig (options = {}) {
  const config = require('./config.json')
  const inTravis = !!process.env.TRAVIS

  if (inTravis) {
    config.password = ''
    config.schema = process.env.TRAVIS_JOB_ID
  }

  if (options.testKey) {
    config.schema = `pgboss${sha1(options.testKey).slice(-10)}${inTravis ? '_' + config.schema : ''}`
  }

  config.schema = config.schema || 'pgboss'

  const result = { ...config }

  return Object.assign(result, options)
}

async function getDb () {
  const config = getConfig()
  const db = new Db(config)
  await db.open()
  await db.executeSql('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  return db
}

async function dropSchema (schema) {
  const db = await getDb()
  await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
}

async function getJobById (schema, id) {
  const response = await findJobs(schema, 'id = $1', [id])
  return response.rows.length ? response.rows[0] : null
}

async function findJobs (schema, where, values) {
  const db = await getDb()
  const jobs = await db.executeSql(`select * from ${schema}.job where ${where}`, values)
  return jobs
}

async function getArchivedJobById (schema, id) {
  const response = await findArchivedJobs(schema, 'id = $1', [id])
  return response.rows.length ? response.rows[0] : null
}

async function findArchivedJobs (schema, where, values) {
  const db = await getDb()
  const result = await db.executeSql(`select * from ${schema}.archive where ${where}`, values)
  return result
}

async function countJobs (schema, where, values) {
  const db = await getDb()
  const result = await db.executeSql(`select count(*) as count from ${schema}.job where ${where}`, values)
  return parseFloat(result.rows[0].count)
}

async function start (options) {
  try {
    options = getConfig(options)
    const boss = new PgBoss(options)
    await boss.start()
    return boss
  } catch (err) {
    // this is nice for occaisional debugging, Mr. Linter
    if (err) {
      throw err
    }
  }
}
