const PgBoss = require('../src/index');
const config = require('./config.json');
const Db = require('../src/db');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('ready', () => init().then(test));

function test() {

    const delaySeconds = 5;

    boss.registerJob('wait', null, (job, done) => {
        var start = new Date(job.data.submitted);
        var end = new Date();

        console.log(`job ${job.id} received in ${Math.floor((end-start)/1000)} seconds with payload: ${job.data.message}`);

        done().then(() => process.exit());
    });

    boss.submitJob('wait', {message: 'hold your horses', submitted: Date.now()}, {startIn: delaySeconds})
        .then(jobId => {
            console.log(`job id ${jobId} requested to start in ${delaySeconds} seconds`);
        });

}


function init(){
    const emptyJobsCommand = 'truncate table pgboss.job';

    var db = new Db(config);

    return db.executeSql(emptyJobsCommand)
        .catch(error => console.error(error));
}