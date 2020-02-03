const Db = require('../src/db')
const PgBoss = require('../src/index')
const plans = require('../src/plans')

module.exports = {
  init,
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

  if (process.env.TRAVIS) {
    config.port = 5432
    config.password = ''
    config.schema = 'pgboss' + process.env.TRAVIS_JOB_ID
  }

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

async function init (schema) {
  schema = schema || getConfig().schema
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

async function start (options = {}) {
  await init(options.schema)
  const boss = new PgBoss(Object.assign(getConfig(), options))
  await boss.start()
  return boss
}
