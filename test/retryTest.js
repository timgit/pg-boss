var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');
var helper = require('./testService');

describe('retries', function() {
    it('should retry a job that didn\'t complete', function (finished) {

        var expireIn = '1 second';
        var retries = 2;

        this.timeout(7000);

        // todo: temp test for travis config override
        if(process.env.TRAVIS) {
            config.port = 5433;
            config.password = '';
        }

        config.expireCheckIntervalSeconds = 1;
        
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
            var subscribeCount = 0;

            boss.subscribe('unreliable', null, function(job, done) {
                // not calling done so it will expire
                subscribeCount++;
            });

            boss.publish('unreliable', null, {
                expireIn: expireIn,
                retryLimit: retries
            });

            setTimeout(function() {
                assert.equal(subscribeCount, retries + 1);
                finished();

            }, 6000);
        }

    });
});
