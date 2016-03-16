const PgBoss = require('../src/index');
const config = require('./config.json');

var boss = new PgBoss(config);

boss.on('error', error => console.error(error));
boss.on('ready', init);

function init() {

    var receivedCount = 0;

    boss.registerJob('oneinahundred', {teamSize: 20}, (job, done) => {
        console.log(`got job ${job.id} payload: ${job.data.message}`);
        done().then(() => {
            receivedCount++;

            if(receivedCount === 100)
                process.exit();
        });
    });

    for(var x=0; x<100; x++){

        boss.submitJob('oneinahundred', {message: x + ' requested'})
            .then(jobId => console.log(`job id ${jobId} submitted`));

    }
}
