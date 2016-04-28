var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');
var helper = require('./testService');

describe('delayed jobs', function(){
    it('should wait before processing a delayed job submission', function(finished) {

        var delaySeconds = 2;
        this.timeout(3000);

        // todo: temp test for travis config override
        if(process.env.TRAVIS) {
            config.port = 5433;
            config.password = '';
        }

        var boss = new PgBoss(config);
        boss.start();

        boss.on('error', error => console.error(error));
        boss.on('ready', () => helper.init().then(ready));

        function ready() {
            boss.subscribe('wait', null, (job, done) => {
                var start = new Date(job.data.submitted);
                var end = new Date();

                var elapsedSeconds = Math.floor((end-start)/1000);

                console.log(`job ${job.id} received in ${elapsedSeconds} seconds with payload: ${job.data.message}`);

                done().then(() => {
                    assert.isAtLeast(delaySeconds, elapsedSeconds);
                    finished();
                });
            });

            boss.publish('wait', {message: 'hold your horses', submitted: Date.now()}, {startIn: delaySeconds})
                .then(jobId => {
                    console.log(`job id ${jobId} requested to start in ${delaySeconds} seconds`);
                });

        }

    });
});



