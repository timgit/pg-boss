const PgBoss = require('../src/index');
const config = require('./config.json');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('ready', init);

function init() {

    const jobCount = 1000;
    var receivedCount = 0;
    const jobName = 'one_of_many'

    boss.registerJob(jobName, {teamSize: jobCount}, (job, done) => {
        console.log(`got job ${job.id} payload: ${job.data.message}`);
        done().then(() => {
            receivedCount++;

            if(receivedCount === jobCount)
                process.exit();
        });
    });

    for(var x=0; x<jobCount; x++){

        boss.submitJob(jobName, {message: x + ' requested'})
            .then(jobId => console.log(`job id ${jobId} submitted`));

    }
}
