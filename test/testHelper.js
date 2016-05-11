var Db = require('../src/db');
var config = require('./config.json');
var PgBoss = require('../src/index');
var Promise = require('bluebird');
var Contractor = require('../src/contractor');

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
    var truncateJobTable = `truncate table ${config.schema}.job`;
    var db = getDb();
    var contractor = new Contractor(config);

    return contractor.isInstalled()
        .then(installed => installed ? db.execute(truncateJobTable) : null)
        .catch(error => console.error(error));
}

function start(options) {

    return new Promise(deferred);

    function deferred(resolve, reject){
        init().then(() => {

            if(options && typeof options == 'object')
                options = extend(config, options);

            var boss = new PgBoss(options || config);

            boss.on('error', error => reject(error));
            boss.on('ready', () => resolve(boss));

            boss.start();
        });
    }

}

function extend(dest, source) {
    for(var key in source) {
        if(source.hasOwnProperty(key))
            dest[key] = source[key];
    }
    return dest;
}