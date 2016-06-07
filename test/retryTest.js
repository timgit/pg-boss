var assert = require('chai').assert;
var helper = require('./testHelper');

describe('retries', function() {

    var boss;

    before(function(finished){
        helper.start({expireCheckInterval:200, newJobCheckInterval: 200})
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    after(function(finished){
        boss.disconnect().then(finished);
    });
    
    it('should retry a job that didn\'t complete', function (finished) {

        var expireIn = '100 milliseconds';
        var retryLimit = 1;
        var subscribeCount = 0;

        boss.subscribe('unreliable', function(job, done) {
            // not calling done so it will expire
            subscribeCount++;
        });

        boss.publish({name: 'unreliable', options: {expireIn, retryLimit}});

        setTimeout(function() {
            assert.equal(subscribeCount, retryLimit + 1);
            finished();

        }, 1000);

    });
});
