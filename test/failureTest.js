const assert = require('chai').assert;
const helper = require('./testHelper');

describe('error', function(){

  let boss;

  before(function(finished){
    helper.start()
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  after(function(finished){
    boss.stop().then(() => finished());
  });

  it('should reject missing id argument', function(finished){
    boss.fail().catch(() => finished());
  });

  it('should fail a job when requested', function(finished){
    this.timeout(3000);

    const jobName = 'will-fail';

    boss.publish(jobName)
      .then(id => boss.fetch(jobName))
      .then(job => boss.fail(job.id))
      .then(() => {
        assert(true);
        finished();
      });

  });

  it('failure event is raised from subscriber error', function(finished) {

    this.timeout(3000);

    const errorMessage = 'something went wrong';
    const jobName = 'suspect-job';
    let jobId;

    boss.on('failed', failure => {
      assert.equal(failure.job.id, jobId);
      assert.equal(errorMessage, failure.error.message);
      boss.removeAllListeners('failed');
      finished();
    });

    boss.subscribe(jobName, job => {
        let myError = new Error(errorMessage);

        job.done(myError)
          .catch(error => {
            console.error(error);
            assert(false, error.message);
          });
      })
      .then(() => boss.publish(jobName))
      .then(id => jobId = id);

  });

  it('should subscribe to a job failure', function(finished){

    this.timeout(3000);

    const jobName = 'subscribe-fail';
    let jobId;

    boss.onFail(jobName, job => {
      assert.strictEqual(jobId, job.data.request.id);
      finished();
    });

    boss.publish(jobName)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => boss.fail(job.id));

  });

  it('should fail a batch of jobs', function(finished){
    const jobName = 'complete-batch';

    Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])
    .then(() => boss.fetch(jobName, 3))
    .then(jobs => boss.fail(jobs.map(job => job.id)))
    .then(() => finished());
  });

  it('should accept a payload', function(finished){
    const jobName = 'fail-payload';    
    const failPayload = {
      someReason: 'nuna'
    };

    boss.publish(jobName)
      .then(jobId => boss.fail(jobId, failPayload))
      .then(() => boss.fetchFailed(jobName))
      .then(job => {
        assert.strictEqual(job.data.response.someReason, failPayload.someReason);
        finished();
      });
  });

  it('should unsubscribe a failure subscription', function(finished){
    this.timeout(4000);

    const jobName = 'offFail';

    let receivedCount = 0;

    boss.onFail(jobName, job => {
      receivedCount++;

      job.done()
        .then(() => boss.offFail(jobName))
        .then(() => boss.publish(jobName))
        .then(jobId => boss.fail(jobId))
    });

    boss.publish(jobName)
      .then(jobId => boss.fail(jobId))
      .then(() => {

        setTimeout(() => {
          assert.strictEqual(receivedCount, 1);
          finished();
        }, 2000);

      });

  });

  it('should fetch a failed job', function(finished){
    const jobName = 'fetchFailed';

    let jobId;

    boss.publish(jobName)
      .then(id => jobId = id)
      .then(() => boss.fail(jobId))
      .then(() => boss.fetchFailed(jobName))
      .then(job => {
        assert.strictEqual(job.data.request.id, jobId);
        finished();
      })
  });

  it('subscribe failure via done() should pass error payload to failed job', function(finished){
    const jobName = 'fetchFailedWithPayload';
    const failPayload = 'mah error';

    boss.subscribe(jobName, job => {
        job.done(failPayload)
          .then(() => boss.fetchFailed(jobName))
          .then(failedJob => {
            assert.strictEqual(failedJob.data.response, failPayload);
            finished();
          })
      })
      .then(() => boss.publish(jobName));

  });

});



