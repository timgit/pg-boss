const PgBoss = require('../lib')

const plans = PgBoss.getMigrationPlans('pgboss', process.argv[2])

console.log(plans)
