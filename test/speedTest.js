var assert = require('chai').assert;
var helper = require('./testHelper');

describe('speed', function() {

    var boss;

    before(function(finished){
        helper.start()
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    var expectedSeconds = 4;
    var jobCount = 1000;

    it('should be able to complete ' + jobCount + ' jobs in ' + expectedSeconds + ' seconds', function (finished) {
        // add an extra second to test timeout
        this.timeout((expectedSeconds + 1) * 1000);

        var receivedCount = 0;
        var jobName = 'one_of_many';

        for (var x = 1; x <= jobCount; x++) {
            boss.publish(jobName, {message: 'message #' + x});
        }

        var startTime = new Date();

        boss.subscribe(jobName, {teamSize: jobCount}, function (job, done) {

            done().then(function () {
                receivedCount++;

                if (receivedCount === jobCount) {
                    var elapsed = new Date().getTime() - startTime.getTime();
                    console.log('finished ' + jobCount + ' jobs in ' + elapsed + 'ms');

                    assert.isBelow(elapsed / 1000, expectedSeconds);
                    finished();
                }

            });
        });
    });
});

