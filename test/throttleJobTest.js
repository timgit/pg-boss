var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');
var helper = require('./testService');

describe('throttle', function() {
    it('should process at most 1 job per second', function (finished) {

        var singletonSeconds = 1;
        var jobCount = 3;
        var publishInterval = 100;
        var assertTimeout = jobCount * 1000;

        // add an extra second to test timeout
        this.timeout((jobCount + 1) * 1000);

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

        function test() {
            var publishCount = 0;
            var subscribeCount = 0;

            boss.subscribe('expensive', null, function(job, done) {
                done().then(function() { subscribeCount++; });
            });

            setTimeout(function() {
                console.log('published ' + publishCount + ' jobs in '  + assertTimeout/1000 + ' seconds but received ' + subscribeCount + ' jobs');
                assert.isAtMost(subscribeCount, jobCount + 1);

                finished();

            }, assertTimeout);


            setInterval(function() {
                boss.publish('expensive', null, {singletonSeconds: singletonSeconds})
                    .then(function() { publishCount++; });
            }, publishInterval);
        }

    });
});
