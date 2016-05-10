var assert = require('chai').assert;
var helper = require('./testHelper');

describe('delayed jobs', function(){
    it('should wait before processing a delayed job submission', function(finished) {

        var delaySeconds = 2;
        this.timeout(3000);

        helper.start().then(boss => {

            boss.subscribe('wait', function(job, done) {
                var start = new Date(job.data.submitted);
                var end = new Date();

                var elapsedSeconds = Math.floor((end-start)/1000);

                console.log('job '+ job.id + ' received in ' + elapsedSeconds + ' seconds with payload: ' + job.data.message);

                done().then(function() {
                    assert.isAtLeast(delaySeconds, elapsedSeconds);
                    finished();
                });
            });

            boss.publish('wait', {message: 'hold your horses', submitted: Date.now()}, {startIn: delaySeconds})
                .then(function(jobId) {
                    console.log('job ' + jobId + ' requested to start in ' + delaySeconds + ' seconds');
                });

        });

    });
});



