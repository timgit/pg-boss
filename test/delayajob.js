const PgBoss = require('../lib/index');
const config = require('./config.json');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
//boss.on('job', job => console.log(`${job.name} job found - ${job.id}`));
boss.on('ready', init);

function init() {

    var start = new Date();

    boss.registerJob('wait5seconds', {teamSize: 1}, (job, done) => {
        var end = new Date();

        console.log(`${end-start} got job ${job.id} payload: ${job.data.message}`);

        done().then(() => process.exit(0));
    });



    boss.submitJob('wait5seconds', {message: 'hold your horses'}, {startIn: 5})
        .then(jobId => console.log(`job id ${jobId} submitted`));

}
