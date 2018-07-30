const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('archive', function() {

  this.timeout(10000);

  let boss;

  before(function(finished){
    helper.start({archiveCompletedJobsEvery:'1 second', archiveCheckInterval: 500})
      .then(dabauce => {
        boss = dabauce;

        finished();
      });
  });

  after(function(finished) {
    boss.stop().then(() => finished());
  });

  it('should archive a job', function(finished){
    this.timeout(5000);

    let jobName = 'archiveMe';
    let jobId = null;

    boss.publish(jobName)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => assert.equal(job.id, jobId))
      .then(() => boss.complete(jobId))
      .then(() => Promise.delay(2000))
      .then(() => helper.getArchivedJobById(jobId))
      .then(job => {
        assert.isOk(job);
        finished();
      });

  });

});
