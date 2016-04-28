var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');
var helper = require('./testService');

describe('performance', function() {
    it('should be able to complete 1000 jobs in a second', function (finished) {

        // todo: temp test for travis config override
        if(process.env.TRAVIS) {
            config.port = 5433;
            config.password = '';
        }
        
        var boss = new PgBoss(config);
        boss.start();

        boss.on('error', error => console.error(error));
        boss.on('ready', () => helper.init().then(test));

        function test(){
            var jobCount = 1000;
            var receivedCount = 0;
            var jobName = 'one_of_many'

            for(var x=1; x<=jobCount; x++){
                boss.publish(jobName, {message: 'message #' + x});
            }

            var startTime = new Date();

            boss.subscribe(jobName, {teamSize: jobCount}, (job, done) => {

                done().then(() => {
                    receivedCount++;

                    if(receivedCount === jobCount){
                        var elapsed = new Date().getTime() - startTime.getTime();
                        console.log(`finished ${jobCount} jobs in ${elapsed}ms`);

                        assert.isBelow(elapsed/1000, 1);
                        finished();
                    }

                });
            });
        }

    });
});

