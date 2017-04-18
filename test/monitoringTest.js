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
            assert.strictEqual(states.created, 1);
            assert.strictEqual(states.active, 1);
            assert.strictEqual(states.complete, 1);
          } else {
            assert.strictEqual(states.created, 1);
            assert.strictEqual(states.active, 0);
            assert.strictEqual(states.complete, 2);

            finished();
          }

        });
      })
      .then(() => boss.complete(firstJob.id))
      .then(() => firstJobCompleted = true);

  });

});
