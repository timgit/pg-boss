const PgBoss = require('../src/index');
const config = require('./config.json');
const Db = require('../src/db');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('ready', () => init().then(test));


function test(){
    const jobCount = 1000;
    var receivedCount = 0;
    const jobName = 'one_of_many'

    for(var x=1; x<=jobCount; x++){
        boss.submitJob(jobName, {message: 'message #' + x})
            .then(jobId => console.log(`job id ${jobId} submitted`));
    }

    var startTime = new Date();

    boss.registerJob(jobName, {teamSize: jobCount}, (job, done) => {

        console.log(`got job ${job.id} payload: ${job.data.message}`);

        done().then(() => {
            receivedCount++;

            if(receivedCount === jobCount){
                let elapsed = new Date().getTime() - startTime.getTime();

                console.log(`finished in ${elapsed}ms`);

                process.exit();
            }

        });
    });

}

function init(){
    const emptyJobsCommand = 'truncate table pgboss.job';

    var db = new Db(config);

    return db.executeSql(emptyJobsCommand)
        .catch(error => console.error(error));
}
