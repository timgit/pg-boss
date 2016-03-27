const PgBoss = require('../src/index');
const config = require('./config.json');
const helper = require('./testService');

var boss = new PgBoss(config);
boss.start();

boss.on('error', error => console.error(error));
boss.on('ready', () => helper.init().then(test));

function test() {
    const delaySeconds = 5;

    boss.subscribe('wait', null, (job, done) => {
        var start = new Date(job.data.submitted);
        var end = new Date();

        console.log(`job ${job.id} received in ${Math.floor((end-start)/1000)} seconds with payload: ${job.data.message}`);

        done().then(() => process.exit());
    });

    boss.publish('wait', {message: 'hold your horses', submitted: Date.now()}, {startIn: delaySeconds})
        .then(jobId => {
            console.log(`job id ${jobId} requested to start in ${delaySeconds} seconds`);
        });
}