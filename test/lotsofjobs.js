const PgBoss = require('../src/index');
const config = require('./config.json');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('ready', init);

function init() {

    const jobCount = 100;
    var receivedCount = 0;
    const jobName = 'one_of_many'

    for(var x=1; x<=jobCount; x++){
        boss.submitJob(jobName, {message: 'message #' + x})
            .then(jobId => console.log(`job id ${jobId} submitted`));
    }

    var startTime = new Date();

    boss.registerJob(jobName, {teamSize: 10}, (job, done) => {

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
