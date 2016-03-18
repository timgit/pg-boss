const PgBoss = require('../src/index');
const config = require('./config.json');
const Db = require('../src/db');

var db = new Db(config);

db.executeSql('DROP SCHEMA pgboss CASCADE')
    .then(test)
    .catch(error => console.error(error));

function test() {
    var boss = new PgBoss(config);
    boss.connect();
    boss.on('error', error => console.error(error));
}