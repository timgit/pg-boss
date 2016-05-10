var Db = require('../src/db');
var config = require('./config.json');
var PgBoss = require('../src/index');
var Promise = require('bluebird');

// todo: temp test for travis config override
if(process.env.TRAVIS) {
    config.port = 5433;
    config.password = '';
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
    return getDb().executeSql(`truncate table ${config.schema}.job`)
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