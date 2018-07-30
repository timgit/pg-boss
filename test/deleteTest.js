const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('delete', function() {

  this.timeout(10000);

  let boss;

  before(function(finished){

    const options = {
      archiveCompletedJobsEvery:'1 second',
      archiveCheckInterval: 500,
      deleteArchivedJobsEvery: '1 second',
      deleteCheckInterval: 500
    };

    helper.start(options)
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  after(function(finished) {
    boss.stop().then(() => finished());
  });

  it('should delete an archived job', function(finished){

    let jobName = 'deleteMe';
    let jobId = null;

    boss.publish(jobName)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => assert.equal(jobId, job.id))
      .then(() => boss.complete(jobId))
      .then(() => Promise.delay(3000))
      .then(() => helper.getArchivedJobById(jobId))
      .then(job => {
        assert.strictEqual(job, null);
        finished();
      });

  });

});
