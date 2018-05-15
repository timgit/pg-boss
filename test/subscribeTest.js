const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');

describe('subscribe', function(){

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
    boss.stop()
      .then(() => finished());
  });

  it('should fail with no arguments', function(finished) {
    boss.subscribe()
      .catch(error => finished());
  });

  it('should fail if no callback provided', function(finished) {
    boss.subscribe('foo')
      .catch(error => finished());
  });

  it('should fail if options is not an object', function(finished) {
    boss.subscribe('foo', () => {}, 'nope')
      .catch(error => finished());
  });

  it('should honor a custom new job check interval', function(finished){
    this.timeout(5000);

    let startTime = new Date();
    const newJobCheckIntervalSeconds = 3;

    boss.subscribe('foo', {newJobCheckIntervalSeconds}, job => {
      let elapsed = new Date().getTime() - startTime.getTime();

      assert.isAbove((elapsed / 1000), newJobCheckIntervalSeconds);

      job.done().then(() => finished());
    })
      .then(() => boss.publish('foo'));

  });

  it('should unsubscribe a subscription', function(finished){
    this.timeout(4000);

    const jobName = 'temp';

    let receivedCount = 0;

    boss.subscribe(jobName, job => {
      receivedCount++;

      job.done()
        .then(() => boss.unsubscribe(jobName))
        .then(() => boss.publish(jobName))
    });

    boss.publish(jobName)
      .then(() => {

        setTimeout(() => {
          assert.isAtMost(receivedCount, 1);
          finished();
        }, 2000);

      });

  });

  it('unsubscribe should fail without a name', function(finished){
    boss.unsubscribe().catch(() => finished());
  });

  it('should handle a batch of jobs via teamSize', function(finished){
    const jobName = 'subscribe-teamSize';
    const teamSize = 4;
    let subscribeCount = 0;

    Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])
      .then(() => boss.subscribe(jobName, {teamSize}, job =>
        job.done()
          .then(() => {
            subscribeCount++;

            // idea here is that the test would time out if it had to wait for 4 intervals
            if(subscribeCount === teamSize)
              finished();
          })
        )
      );
  });

  it('should handle a batch of jobs via batchSize', function(finished){
    const jobName = 'subscribe-batchSize';
    const batchSize = 4;
    let subscribeCount = 0;

    Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])
      .then(() => boss.subscribe(jobName, {batchSize}, jobs =>
        boss.complete(jobs.map(job => job.id))
          .then(() => {
            assert.equal(jobs.length, batchSize);
            finished();
          })
        )
      );
  });

  it('returning promise applies backpressure', function(finished){

    const queue = 'backpressure';
    let subscribeCount = 0;

    let jobs = [
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ];

    Promise.all(jobs)
      .then(() => boss.subscribe(queue, job => Promise.delay(2000).then(() => subscribeCount++)))
      .then(() => setTimeout(() => {
        assert.isBelow(subscribeCount, jobs.length);
        finished();
      }, 7000));

  });

  it('should have a done callback for single job subscriptions', function(finished){
    const name = 'subscribe-single';

    boss.subscribe(name, job=> {
        return job.done().then(() => finished());
      })
      .then(() => boss.publish(name));

  });

});



