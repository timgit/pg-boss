const PgBoss = require('../src/index');
const config = require('./config.json');
const helper = require('./testService');

var boss = new PgBoss(config);
boss.start();

boss.on('error', error => console.error(error));
boss.on('ready', () => helper.init().then(test));

function test(){
    const jobCount = 1000;
    var receivedCount = 0;
    const jobName = 'one_of_many'

    for(var x=1; x<=jobCount; x++){
        boss.publish(jobName, {message: 'message #' + x})
            .then(jobId => console.log(`job id ${jobId} submitted`));
    }

    var startTime = new Date();

    boss.subscribe(jobName, {teamSize: jobCount}, (job, done) => {

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