const assert = require('chai').assert;
const helper = require('./testHelper');

describe('subscribe', function(){

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

  it('should fail with no arguments', function(finished) {
    boss.subscribe().catch(error => {
      assert(true);
      finished();
    });
  });

  it('should fail if no callback provided', function(finished) {
    boss.subscribe('foo').catch(error => {
      assert(true);
      finished();
    });
  });

  it('should fail if options is not an object', function(finished) {
    boss.subscribe('foo', () => {}, 'nope').catch(error => {
      assert(true);
      finished();
    });
  });

  it('should honor a custom new job check interval', function(finished){
    this.timeout(5000);

    let startTime = new Date();
    const newJobCheckIntervalSeconds = 3;

    boss.subscribe('foo', {newJobCheckIntervalSeconds}, (job, done) => {
      let elapsed = new Date().getTime() - startTime.getTime();

      assert.isAbove((elapsed / 1000), newJobCheckIntervalSeconds);

      done()
        .then(() => finished());

    }).then(() => {
      boss.publish('foo');
    });

  });

  it('should unsubscribe a subscription', function(finished){
    this.timeout(4000);

    const jobName = 'temp';

    let receivedCount = 0;

    boss.subscribe(jobName, (job, done) => {
      receivedCount++;

      done()
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

});



