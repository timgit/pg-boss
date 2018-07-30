const assert = require('chai').assert;
const helper = require('./testHelper');

describe('throttle', function() {

  this.timeout(10000);

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

  it('should only create 1 job for interval with a delay', function(finished){

    const jobName = 'delayThrottle';
    const singletonSeconds = 4;
    const startAfter = 2;

    const jobCount = 1;

    const publishInterval = 500;
    const assertTimeout = 4000;

    this.timeout(assertTimeout + 1000);

    let publishCount = 0;
    let subscribeCount = 0;

    boss.subscribe(jobName, job => {
      job.done()
        .then(() => subscribeCount++);
    });

    let intervalId;
    let shuttingDown = false;

    setTimeout(function() {
      console.log('published ' + publishCount + ' jobs in '  + assertTimeout/1000 + ' seconds but received ' + subscribeCount + ' jobs');
      assert.isAtMost(subscribeCount, jobCount + 1);

      shuttingDown = true;
      clearInterval(intervalId);
      finished();

    }, assertTimeout);


    intervalId = setInterval(function() {
      if(shuttingDown) return;
      boss.publish(jobName, null, {startAfter, singletonSeconds})
        .then(function() { publishCount++; });
    }, publishInterval);
  });

  it('should process at most 1 job per second', function (finished) {

    const singletonSeconds = 1;
    const jobCount = 3;
    const publishInterval = 100;
    const assertTimeout = jobCount * 1000;

    // add an extra second to test timeout
    this.timeout((jobCount + 1) * 1000);

    let publishCount = 0;
    let subscribeCount = 0;

    boss.subscribe('expensive', job => {
      job.done()
        .then(() => subscribeCount++);
    });

    let intervalId;
    let shuttingDown = false;

    setTimeout(function() {
      console.log('published ' + publishCount + ' jobs in '  + assertTimeout/1000 + ' seconds but received ' + subscribeCount + ' jobs');
      assert.isAtMost(subscribeCount, jobCount + 1);

      shuttingDown = true;
      clearInterval(intervalId);
      finished();

    }, assertTimeout);


    intervalId = setInterval(function() {
      if(shuttingDown) return;
      boss.publish('expensive', null, {singletonSeconds: singletonSeconds})
        .then(function() { publishCount++; });
    }, publishInterval);

  });


  it('should debounce', function (finished) {

    this.timeout(3000);

    const jobName = 'debounce';

    boss.publish(jobName, null, {singletonHours: 1})
      .then(jobId => {
        assert.isOk(jobId);
        return boss.publish(jobName, null, {singletonHours: 1, singletonNextSlot:true});
      })
      .then(jobId => {
        assert.isOk(jobId);
        finished();
      });

  });

  it('should debounce via publishDebounce()', function (finished) {

    this.timeout(3000);

    const jobName = 'publishDebounce()';

    boss.publishDebounced(jobName, null, null, 60)
      .then(jobId => {
        assert.isOk(jobId);
        return boss.publishDebounced(jobName, null, null, 60);
      })
      .then(jobId => {
        assert.isOk(jobId);
        finished();
      });

  });


  it('should reject 2nd request in the same time slot', function (finished) {

    this.timeout(3000);

    const jobName = 'throttle-reject-2nd';

    boss.publish(jobName, null, {singletonHours: 1})
      .then(jobId => {
        assert.isOk(jobId);
        return boss.publish(jobName, null, {singletonHours: 1});
      })
      .then(jobId => {
        assert.isNotOk(jobId);
        finished();
      });

  });

  it('should throttle via publishThrottled()', function (finished) {

    this.timeout(3000);

    const jobName = 'publishThrottled()';

    boss.publishThrottled(jobName, null, null, 2)
      .then(jobId => {
        assert.isOk(jobId);
        return boss.publishThrottled(jobName, null, null, 2);
      })
      .then(jobId => {
        assert.isNotOk(jobId);
        finished();
      });

  });

});
