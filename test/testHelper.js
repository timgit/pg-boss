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
  findJobs,
  completedJobPrefix: plans.completedJobPrefix,
  countJobs,
  empty,
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

async function getDb (config) {
  const db = new Db(config || getConfig())
  await db.open()
  return db
}

async function empty () {
  const db = await getDb()
  await db.executeSql(`TRUNCATE TABLE ${getConfig().schema}.job`)
}

async function dropSchema (schema) {
  const db = await getDb()
  await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
}

async function getJobById (id) {
  const response = await findJobs('id = $1', [id])
  return response.rows.length ? response.rows[0] : null
}

async function findJobs (where, values) {
  const db = await getDb()
  const jobs = await db.executeSql(`select * from ${getConfig().schema}.job where ${where}`, values)
  return jobs
}

async function getArchivedJobById (id) {
  const response = await findArchivedJobs('id = $1', [id])
  return response.rows.length ? response.rows[0] : null
}

async function findArchivedJobs (where, values) {
  const db = await getDb()
  const result = await db.executeSql(`select * from ${getConfig().schema}.archive where ${where}`, values)
  return result
}

async function countJobs (where, values) {
  const db = await getDb()
  const result = await db.executeSql(`select count(*) as count from ${getConfig().schema}.job where ${where}`, values)
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
