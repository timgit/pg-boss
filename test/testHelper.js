const Db = require('../src/db');
const PgBoss = require('../src/index');
const plans = require('../src/plans');

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
};

function getConnectionString() {
    let config = getConfig();

    return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`;
}

function getConfig(){
    let config = require('./config.json');

    if(process.env.TRAVIS) {
        config.port = 5432;
        config.password = '';
        config.schema = 'pgboss' + process.env.TRAVIS_JOB_ID;
    }

    return {...config}
}

function getDb(config) {
    return new Db(config || getConfig());
}

async function empty(){
    await getDb().executeSql(`TRUNCATE TABLE ${getConfig().schema}.job`)
}

async function init(schema) {
    schema = schema || getConfig().schema;
    await getDb().executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
}

async function getJobById(id) {
    const response = await findJobs('id = $1', [id])
    return response.rows.length ? response.rows[0] : null
}

async function findJobs(where, values) {
    const db = getDb()
    const jobs = await db.executeSql(`select * from ${getConfig().schema}.job where ${where}`, values)
    return jobs
}

async function getArchivedJobById(id) {
    const response = await findArchivedJobs('id = $1', [id])
    return response.rows.length ? response.rows[0] : null
}

async function findArchivedJobs(where, values){
    const db = getDb()
    return await db.executeSql(`select * from ${getConfig().schema}.archive where ${where}`, values)
}

async function countJobs(where, values){
    const db = getDb()
    const result = await db.executeSql(`select count(*) as count from ${getConfig().schema}.job where ${where}`, values)
    return parseFloat(result.rows[0].count)
}

async function start(options = {}) {
    await init(options.schema)
    const boss = new PgBoss(Object.assign(getConfig(), options))
    await boss.start()
    return boss
}
