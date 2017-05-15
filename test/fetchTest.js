const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');

describe('fetch', function(){

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

  it('should reject missing id argument', function(finished){
    boss.fetch().catch(() => finished());
  });

  it('should get a single job by name and manually complete', function(finished) {
    let jobName = 'no-subscribe-required';

    boss.publish(jobName)
      .then(() => boss.fetch(jobName))
      .then(job => {
        assert(jobName === job.name);
        return boss.complete(job.id);
      })
      .then(() => {
        assert(true);
        finished();
      });
  });

  it('should get a batch of jobs as an array', function(finished){
    const jobName = 'fetch-batch';
    const batchSize = 4;

    Promise.join(
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    )
    .then(() => boss.fetch(jobName, batchSize))
    .then(jobs => {
      assert(jobs.length === batchSize);
      finished();
    });
  });

});



