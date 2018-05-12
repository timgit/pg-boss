const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('expire', function() {

  this.timeout(10000);

  let boss;

  // sanitizing each test run for expiration events
  beforeEach(function(finished){
    helper.start({expireCheckInterval:500})
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  afterEach(function(finished) {
    boss.stop().then(() => finished());
  });

  it('should expire a job', function(finished){
    this.timeout(5000);

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

    boss.subscribe(jobName, job => {});
  });

});
