const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');

describe('speed', function() {

  const expectedSeconds = 4;
  const jobCount = 2000;
  const jobName = 'one_of_many';
  const jobs = new Array(jobCount).fill(null);
  const testTitle = `should be able to complete ${jobCount} jobs in ${expectedSeconds} seconds`;

  let boss;

  before(function(finished){
    this.timeout(expectedSeconds * 1000);

    helper.start()
      .then(dabauce => {
        boss = dabauce;

        Promise.map(jobs, (val, index) => boss.publish(jobName, {message: 'message #' + index}))
          .then(() => finished());
      });
  });

  after(function(finished){
    boss.stop().then(() => finished());
  });

  it(testTitle, function(finished) {
    this.timeout(expectedSeconds * 1000);

    const startTime = new Date();

    boss.fetch(jobName, jobCount)
      .then(jobs => Promise.map(jobs, job => boss.complete(job.id)))
      .then(() => {
        let elapsed = new Date().getTime() - startTime.getTime();

        console.log(`finished ${jobCount} jobs in ${elapsed}ms`);

        assert.isBelow(elapsed / 1000, expectedSeconds);
        finished();
    });
  });

});

