const PgBoss = require('../lib/index');
const config = require('./config.json');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('job', job => console.log(`${job.name} job found - ${job.id}`));
boss.on('ready', init);

function init() {

    boss.registerJob('waitabit', {teamSize: 1}, (job, done) => {
        console.log(`got job ${job.id} payload: ${job.data.message}`);
        done();
    });

    boss.submitJob('waitabit', {message: 'hold your horses'}, {delay: 5000})
        .then(jobId => console.log(`job id ${jobId} submitted`));

}
