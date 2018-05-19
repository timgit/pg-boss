const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('retries', function() {

  this.timeout(10000);

  let boss;

  before(function(finished){
    helper.start({expireCheckInterval:200, newJobCheckInterval: 200})
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

    }, 3000);

  });

  it('should retry a job that failed', function(finished){
    const queueName = 'retryFailed';
    const retryLimit = 1;

    boss.publish(queueName, null, {retryLimit})
      .then(() => boss.fetch(queueName))
      .then(job => boss.fail(job.id))
      .then(() => boss.fetch(queueName))
      .then(job => {
        assert(job, `failed job didn't get a 2nd chance`);
        finished();
      });
  });

  it('should retry with a fixed delay', function(finished){
    const queue = 'retryDelayFixed';

    boss.publish(queue, null, {retryLimit: 1, retryDelay: 1})
      .then(() => boss.fetch(queue))
      .then(job => boss.fail(job.id))
      .then(() => boss.fetch(queue))
      .then(job => assert.strictEqual(job, null))
      .then(() => Promise.delay(1000))
      .then(() => boss.fetch(queue))
      .then(job => {
        assert.isOk(job);
        finished();
      });

  });


  it('should retry with a exponential backoff', function(finished){
    const queue = 'retryDelayBackoff';
    let subscribeCount = 0;
    let retryLimit = 3;

    boss.subscribe(queue, job => {
      subscribeCount++;
      job.done('fail!');
    });

    boss.publish(queue, null, {retryLimit, retryDelay: 1, retryBackoff: true});

    setTimeout(() => {
      assert.isBelow(subscribeCount, retryLimit);
    }, 4000);

    setTimeout(() => {
      assert.equal(subscribeCount, retryLimit);
      finished();
    }, 9000);

  });


});
