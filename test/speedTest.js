const assert = require('chai').assert;
const helper = require('./testHelper');

describe('speed', function() {

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

  const expectedSeconds = 4;
  const jobCount = 1000;

  it('should be able to complete ' + jobCount + ' jobs in ' + expectedSeconds + ' seconds', function (finished) {
    // add an extra second to test timeout
    this.timeout((expectedSeconds + 1) * 1000);

    const jobName = 'one_of_many';
    let receivedCount = 0;

    for (let x = 1; x <= jobCount; x++) {
      boss.publish(jobName, {message: 'message #' + x});
    }

    const startTime = new Date();

    boss.subscribe(jobName, {teamSize: jobCount}, function (job, done) {

      done().then(function () {
        receivedCount++;

        if (receivedCount === jobCount) {
          let elapsed = new Date().getTime() - startTime.getTime();

          console.log('finished ' + jobCount + ' jobs in ' + elapsed + 'ms');

          assert.isBelow(elapsed / 1000, expectedSeconds);

          finished();
        }

      });
    });
  });
});

