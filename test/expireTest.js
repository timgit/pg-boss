const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('expire', function() {

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

    boss.subscribe(jobName, job => {});
  });


  it('should unsubscribe an expiration subscription', function(finished){
    this.timeout(4000);

    const jobName = 'offExpire';
    const jobRequest = {name: jobName, options: {expireIn:'1 second'}};

    boss.on('expired-count', count => console.log(`${count} jobs expired.`));

    let receivedCount = 0;

    boss.subscribe(jobName, job => {});

    boss.onExpire(jobName, job => {
      receivedCount++;

      boss.offExpire(jobName)
        .then(() => boss.publish(jobRequest));
    });

    boss.publish(jobRequest)
      .then(() => {

        setTimeout(() => {
          assert.strictEqual(receivedCount, 1);
          finished();
        }, 3000);

      });

  });

  it('should fetch an expired job', function(finished){

    this.timeout(3000);

    const jobName = 'fetchExpired';
    const jobRequest = {name: jobName, options: {expireIn:'1 second'}};

    let jobId;

    boss.publish(jobRequest)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(() => Promise.delay(2000))
      .then(() => boss.fetchExpired(jobName))
      .then(job => {
        assert.strictEqual(job.id, jobId);
        finished();
      })
  });

});
