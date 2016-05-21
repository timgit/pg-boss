var Db = require('../src/db');
var config = require('./config.json');
var PgBoss = require('../src/index');

if(process.env.TRAVIS) {
    config.port = 5433;
    config.password = '';
    config.schema = 'pgboss' + process.env.TRAVIS_JOB_ID;
}

module.exports = {
    init: init,
    start: start,
    extend: extend,
    getDb: getDb,
    config: config,
    connectionString: `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
};

function getDb() {
    return new Db(config);
}

function init() {
    return getDb().executeSql(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`);
}

function start(options) {

    return init()
        .then(() => {
            if(options && typeof options == 'object')
                options = extend(config, options);

            return new PgBoss(options || config).start();
        });
}

function extend(dest, source) {
    for(var key in source) {
        if(source.hasOwnProperty(key))
            dest[key] = source[key];
    }
    return dest;
}