const PgBoss = require('../src/index');
const config = require('./config.json');
const helper = require('./testService');

var boss = new PgBoss(config);
boss.start();

boss.on('error', error => console.error(error));
boss.on('ready', () => helper.init().then(test));

function test() {
    const every5seconds = 5;
    const jobCount = 3;

    var receivedCount = 0;
    var x = 1;
    var startTime = new Date();

    boss.subscribe('expensive', null, (job, done) => {
        var now = new Date();

        console.log(`job ${job.id} received after ${now - startTime / 1000} seconds with payload: ${job.data.message}`);

        done().then(() => {
            receivedCount++;

            if(receivedCount === jobCount)
                process.exit();
        });
    });

    setInterval(() => {
        boss.publish('expensive', {message: 'message #' + x++}, {singletonSeconds: every5seconds})
            .then(jobId => console.log(`job id ${jobId} submitted`));
    }, 200);
    
}