var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');
var helper = require('./testService');

describe('throttle', function() {
    it('should only process 1 job every second', function (finished) {

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
        boss.start();

        boss.on('error', error => console.error(error));
        boss.on('ready', () => helper.init().then(test));

        function test() {
            var publishCount = 0;
            var subscribeCount = 0;

            boss.subscribe('expensive', null, (job, done) => {
                done().then(() => subscribeCount++);
            });

            setTimeout(() => {
                console.log('published ' + publishCount + ' jobs in '  + assertTimeout/1000 + ' seconds ' + ' and received only ' + subscribeCount + ' jobs');
                assert.isAtMost(subscribeCount, jobCount + 1);

                finished();

            }, assertTimeout)


            setInterval(() => {
                boss.publish('expensive', null, {singletonSeconds: singletonSeconds})
                    .then(() => publishCount++);
            }, publishInterval);
        }

    });
});
