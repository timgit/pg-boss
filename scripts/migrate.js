const PgBoss = require('../lib');

let plans = PgBoss.getMigrationPlans('pgboss', process.argv[2]);

console.log(plans);
