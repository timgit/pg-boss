const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');

describe('complete', function() {

  let boss;

  before(function(finished){
    helper.start()
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  after(function(finished) {
    boss.stop().then(() => finished());
  });

  it('should reject missing id argument', function(finished){
    boss.complete().catch(() => finished());
  });

  it('should complete a batch of jobs', function(finished){
    const jobName = 'complete-batch';

    Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])
    .then(() => boss.fetch(jobName, 3))
    .then(jobs => boss.complete(jobs.map(job => job.id)))
    .then(() => finished());

  });

  it('onComplete should have the payload from complete() in the response object', function(finished){

    const jobName = 'part-of-something-important';
    const responsePayload = {message: 'super-important-payload', arg2: '123'};

    let jobId = null;

    boss.onComplete(jobName, job => {
      assert.equal(job.data.response.message, responsePayload.message);
      assert.equal(job.data.response.arg2, responsePayload.arg2);

      finished();
    });

    boss.publish(jobName)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id, responsePayload));

  });

  it('onComplete should have the original payload in request object', function(finished){

    const jobName = 'onCompleteRequestTest';
    const requestPayload = {foo:'bar'};

    let jobId = null;

    boss.onComplete(jobName, job => {
      assert.equal(jobId, job.data.request.id);
      assert.equal(job.data.request.data.foo, requestPayload.foo);

      finished();
    });

    boss.publish(jobName, requestPayload)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id));

  });

  it('onComplete should have both request and response', function(finished){

    const jobName = 'onCompleteFtw';
    const requestPayload = {token:'trivial'};
    const responsePayload = {message: 'so verbose', code: '1234'};

    let jobId = null;

    boss.onComplete(jobName, job => {
      assert.equal(jobId, job.data.request.id);
      assert.equal(job.data.request.data.token, requestPayload.token);
      assert.equal(job.data.response.message, responsePayload.message);
      assert.equal(job.data.response.code, responsePayload.code);

      console.log(JSON.stringify(job, null, '  '));

      finished();
    });

    boss.publish(jobName, requestPayload)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id, responsePayload));

  });

  it(`subscribe()'s job.done() should allow sending completion payload`, function(finished){
    const jobName = 'complete-from-subscribe';
    const responsePayload = {arg1: '123'};

    boss.onComplete(jobName, job => {
      assert.equal(job.data.response.arg1, responsePayload.arg1);
      finished();
    });

    boss.publish(jobName)
      .then(() => boss.subscribe(jobName, job => job.done(null, responsePayload)));

  });


  it('should unsubscribe an onComplete subscription', function(finished){
    this.timeout(3000);

    const jobName = 'offComplete';

    let receivedCount = 0;

    boss.onComplete(jobName, job => {
      receivedCount++;

      boss.offComplete(jobName)
        .then(() => boss.publish(jobName))
        .then(() => boss.fetch(jobName))
        .then(job => boss.complete(job.id));
    });

    boss.publish(jobName)
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id))
      .then(() => {

        setTimeout(() => {
          assert.strictEqual(receivedCount, 1);
          finished();
        }, 2000);

      });

  });

  it('should fetch a completed job', function(finished){
    const jobName = 'fetchCompleted';

    let jobId;

    boss.publish(jobName)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(() => boss.complete(jobId))
      .then(() => boss.fetchCompleted(jobName))
      .then(job => {
        assert.strictEqual(job.data.request.id, jobId);
        finished();
      })
  });

});
