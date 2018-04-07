const assert = require('chai').assert;
const helper = require('./testHelper');

describe('priority', function(){

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
    boss.stop().then(() => finished());
  });

  it('should process a newer higher priority job before an older lower priority job', function(finished) {

    const jobName = 'priority-test';
    let lowerPriority, higherPriority;

    boss.publish(jobName)
      .then(jobId => {
        lowerPriority = jobId;
        return boss.publish(jobName, null, {priority: 1})
      })
      .then(jobId => {
        higherPriority = jobId;
        return boss.fetch(jobName)
      })
      .then(job => {
        assert.equal(job.id, higherPriority);
        finished();
      });

  });

  it('should process several jobs in descending priority order', function(finished) {

    const jobName = 'multiple-priority-test';
    let low, medium, high;

    boss.publish(jobName, null, {priority: 1})
      .then(jobId => {
        low = jobId;
        return boss.publish(jobName, null, {priority: 5})
      })
      .then(jobId => {
        medium = jobId;
        return boss.publish(jobName, null, {priority: 10})
      })
      .then(jobId => {
        high = jobId;
        return boss.fetch(jobName);
      })
      .then(job => {
        assert.equal(job.id, high);
        return boss.fetch(jobName);
      })
      .then(job => {
        assert.equal(job.id, medium);
        return boss.fetch(jobName);
      })
      .then(job => {
        assert.equal(job.id, low);
        finished();
      })

  });

});



