const assert = require('chai').assert;
const helper = require('./testHelper');

describe('retries', function() {

  let boss;
  const retryMinDelay = 0.1;

  before(function(finished){
    helper.start({expireCheckInterval:100, newJobCheckInterval: 100, retryMinDelay})
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  after(function(finished){
    boss.stop().then(() => finished());
  });

  it('should retry a job that didn\'t complete', function (finished) {

    const expireIn = '100 milliseconds';
    const retryLimit = 1;

    let subscribeCount = 0;

    // don't call job.done() so it will expire
    boss.subscribe('unreliable', job => subscribeCount++);

    boss.publish({name: 'unreliable', options: {expireIn, retryLimit}});

    setTimeout(function() {
      assert.equal(subscribeCount, retryLimit + 1);
      finished();

    }, 1000);

  });

  it('should retry retriable failed job', function(finished) {
      const retryLimit = 1;

      let tryCount = 0;

      // don't call job.done() so it will expire
      boss.subscribe('unreliable-retriable', (job) => {
        tryCount += 1;
        const myError = new Error('Something keeps going wrong');
        myError.shouldRetry = true;
        job.done(myError).catch(error => {
          console.error(error);
          assert(false, error.message);
        });
      });

      boss.publish({name: 'unreliable-retriable', options: { retryLimit, retryMinDelay }});

      setTimeout(function() {
        assert.equal(tryCount, retryLimit + 1);
        finished();

      }, 1000);
  });

  it('should set exponential back off for retries', function(finished) {
    this.timeout(10000);

    const retryLimit = 3;

    let tryCount = 0;
    let expectedDelay = 0;

    let start = new Date();

    const errorMessage = 'something went wrong';
    const jobName = 'retry-backoff';
    let jobId;

    boss.on('failed', failure => {
      if (!failure.retry) {
        boss.removeAllListeners('failed');
        finished();
      }
    });

    boss.subscribe(jobName, job => {
      if (tryCount) {
        try {
          let end = new Date();
          let elapsedMillis = Math.floor((end-start));
          expectedDelay += retryMinDelay * 1000 * Math.pow(2, tryCount - 1);
          console.log(`Retried job ${tryCount} times after ${elapsedMillis}ms (expect ${expectedDelay} to ${expectedDelay + 300})`);
          assert.isAtLeast(elapsedMillis, expectedDelay);
          // Processing resolution is ~200ms
          assert.isAtMost(elapsedMillis, expectedDelay + 300);
        } catch (err) {
          boss.removeAllListeners('failed');
          finished(err);
        }
      }

      tryCount += 1;
      let myError = new Error(errorMessage);
      myError.shouldRetry = true;

      job.done(myError)
        .catch(error => {
          console.error(error);
          assert(false, error.message);
        });
    })
    .then(() => boss.publish({name: jobName, options: {retryLimit, retryMinDelay}}))
    .then(id => jobId = id);
  });

  it('should fail retriable job after retryLimit is reached', function(finished) {
    this.timeout(3000);

    const retryLimit = 1;

    let tryCount = 0;

    const errorMessage = 'something went wrong';
    const jobName = 'hopeless-retries';
    let jobId;

    boss.on('failed', failure => {
      if (!failure.retry) {
        assert.equal(tryCount, retryLimit + 1, 'Job was not failed after correct number of retries');
        assert.equal(failure.job.id, jobId);
        assert.equal(errorMessage, failure.error.message);
        boss.removeAllListeners('failed');
        finished();
      }
    });

    boss.subscribe(jobName, job => {
      tryCount += 1;
      let myError = new Error(errorMessage);
      myError.shouldRetry = true;

      job.done(myError)
        .catch(error => {
          console.error(error);
          assert(false, error.message);
        });
    })
    .then(() => boss.publish({name: jobName, options: {retryLimit}}))
    .then(id => jobId = id);

  });
});
