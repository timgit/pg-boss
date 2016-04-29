var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');
var helper = require('./testService');

var expectedSeconds = 5;
var jobCount = 1000;

describe('performance', function() {
    it('should be able to complete ' + jobCount + ' jobs in ' + expectedSeconds + ' seconds', function (finished) {

        // todo: temp test for travis config override
        if(process.env.TRAVIS) {
            config.port = 5433;
            config.password = '';
        }

        var boss = new PgBoss(config);

        boss.on('error', logError);
        boss.on('ready', ready);

        boss.start();

        function logError(error) {
            console.error(error);
        }

        function ready() {
            helper.init()
                .then(test);
        }

        function test(){
            var receivedCount = 0;
            var jobName = 'one_of_many';

            for(var x=1; x<=jobCount; x++){
                boss.publish(jobName, {message: 'message #' + x});
            }

            var startTime = new Date();

            boss.subscribe(jobName, {teamSize: jobCount}, function(job, done) {

                done().then(function() {
                    receivedCount++;

                    if(receivedCount === jobCount){
                        var elapsed = new Date().getTime() - startTime.getTime();
                        console.log('finished ' + jobCount + ' jobs in ' + elapsed + 'ms');

                        assert.isBelow(elapsed/1000, expectedSeconds);
                        finished();
                    }

                });
            });
        }

    });
});

