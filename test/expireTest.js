const assert = require('chai').assert;
const helper = require('./testHelper');

describe('expire', function() {

    let boss;

    before(function(finished){
        helper.start({expireCheckInterval:500})
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    after(function(finished) {
       boss.stop().then(() => finished()); 
    });
    
    it('should expire a job', function(finished){
        this.timeout(4000);

        let jobName = 'i-take-too-long';
        let jobId = null;

        boss.on('expired-count', count => assert.equal(1, count));
        boss.on('expired-job', job => assert.equal(job.id, jobId));

        boss.publish({name: jobName, options: {expireIn:'1 second'}})
          .then(id => jobId = id);

        boss.onExpire(jobName, job => {
          // giving event emitter assertions a chance
          setTimeout(() => {
            assert.equal(jobId, job.id);
            finished();
          }, 500);

        });

        boss.subscribe(jobName, (job, done) => {
            // got a live one here
        });

    });

});
