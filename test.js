const PgBoss = require('./index');
const config = require('./config.json');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('job', job => console.log(`${job.name} job found - ${job.id}`));
boss.on('ready', init);

function init() {

    boss.registerJob('log', {teamSize: 20}, (job, done) => {
        console.log(`got job ${job.id} payload: ${job.data.message}`);
        done();
    });

    for(var x=0; x<100; x++){

        boss.submitJob('log', {message: x + ' requested'})
            .then(jobId => console.log(`job id ${jobId} submitted`));

    }
}
