const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');

describe('speed', function() {

  const expectedSeconds = 5;
  const jobCount = 10000;
  const name = 'speedTest';

  this.timeout(10000);

  const jobs = new Array(jobCount).fill(null).map((item, index) => ({name, data:{index}}));

  const testTitle = `should be able to complete ${jobCount} jobs in ${expectedSeconds} seconds`;

  let boss;

  before(function(finished){
    helper.start()
      .then(dabauce => {
        boss = dabauce;

        Promise.map(jobs, job => boss.publish(job.name, job.data))
          .then(() => finished());
      });
  });

  after(function(finished){
    boss.stop().then(() => finished());
  });

  it(testTitle, function(finished) {
    this.timeout(expectedSeconds * 1000);

    const startTime = new Date();

    boss.fetch(name, jobCount)
      .then(jobs => boss.complete(jobs.map(job => job.id)))
      .then(() => {
        let elapsed = new Date().getTime() - startTime.getTime();

        console.log(`finished ${jobCount} jobs in ${elapsed}ms`);

        assert.isBelow(elapsed / 1000, expectedSeconds);

        finished();
    });
  });

});

