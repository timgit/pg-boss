const assert = require('chai').assert;
const helper = require('./testHelper');

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
});
