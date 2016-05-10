var assert = require('chai').assert;
var helper = require('./testHelper');

describe('publish', function(){
    it('should publish undefined for payload without error', function(finished) {

        helper.start().then(boss => {

            var jobName = 'publishUndefined';

            boss.subscribe(jobName, (job, done) => {
                done().then(() => {
                    assert(true);
                    finished();
                });
            });

            boss.publish(jobName);

        });

    });

});



