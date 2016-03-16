const PgBoss = require('../src/index');
const config = require('./config.json');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('ready', init);

function init() {

    boss.registerJob('wait5seconds', null, (job, done) => {
        var start = new Date(job.data.submitted);
        var end = new Date();

        console.log(`${end-start} got job ${job.id} payload: ${job.data.message}`);

        done().then(() => process.exit());
    });

    boss.submitJob('wait5seconds', {message: 'hold your horses', submitted: Date.now()}, {startIn: 5})
        .then(jobId => {
            console.log(`job id ${jobId} submitted`);
        });

}
