const assert = require('chai').assert;
const helper = require('./testHelper');

describe('monitoring', function() {

  let boss;

  before(function (finished) {
    helper.start({monitorStateIntervalSeconds: 1})
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  after(function (finished) {
    boss.stop().then(() => finished());
  });

  it('should emit state counts', function (finished) {
    this.timeout(5000);

    let jobName = 'monitorMe';
    let firstJob, firstJobCompleted;

    boss.publish(jobName)
      .then(() => boss.publish(jobName))
      .then(() => boss.publish(jobName))
      .then(() => boss.fetch(jobName))
      .then(job => {
        firstJob = job;
        return boss.fetch(jobName);
      })
      .then(job => boss.complete(job.id))
      .then(() => {
        boss.on('monitor-states', states => {

          if(!firstJobCompleted){
            assert.equal(states.created, 1);
            assert.equal(states.active, 1);
            assert.equal(states.complete, 1);
          } else {
            assert.equal(states.created, 1);
            assert.equal(states.active, 0);
            assert.equal(states.complete, 2);

            finished();
          }

        });
      })
      .then(() => boss.complete(firstJob.id))
      .then(() => firstJobCompleted = true);

  });

});
