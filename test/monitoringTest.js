const assert = require('chai').assert;
const helper = require('./testHelper');
const Boss = require('../src/boss');

describe('monitoring', function() {

  let silentBob = new Boss(helper.getDb(), helper.getConfig());
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

    boss.publish(jobName)
      .then(() => boss.publish(jobName))
      .then(() => silentBob.countStates())
      .then(states => {
        assert.strictEqual(2, states[jobName].created, 'created count is wrong after 2 publishes');
        assert.strictEqual(0, states[jobName].active, 'active count is wrong after 2 publishes');
      })
      .then(() => boss.publish(jobName))
      .then(() => boss.fetch(jobName))
      .then(() => silentBob.countStates())
      .then(states => {
        assert.strictEqual(2, states[jobName].created, 'created count is wrong after 3 publishes and 1 fetch');
        assert.strictEqual(1, states[jobName].active, 'active count is wrong after 3 publishes and 1 fetch');
      })
      .then(() => boss.fetch(jobName))
      .then(() => silentBob.countStates())
      .then(states => {
        assert.strictEqual(1, states[jobName].created, 'created count is wrong after 3 publishes and 2 fetches');
        assert.strictEqual(2, states[jobName].active, 'active count is wrong after 3 publishes and 2 fetches');
      })
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id))
      .then(() => silentBob.countStates())
      .then(states => {
        assert.strictEqual(0, states[jobName].created, 'created count is wrong after 3 publishes and 3 fetches and 1 complete');
        assert.strictEqual(2, states[jobName].active, 'active count is wrong after 3 publishes and 3 fetches and 1 complete');
        assert.strictEqual(1, states[jobName].complete, 'complete count is wrong after 3 publishes and 3 fetches and 1 complete');

        return states;
      })
      .then(lastStates => {

        boss.on('monitor-states', states => {

          assert.strictEqual(lastStates[jobName].created, states[jobName].created, `created count from monitor-states doesn't match`);
          assert.strictEqual(lastStates[jobName].active, states[jobName].active, `active count from monitor-states doesn't match`);
          assert.strictEqual(lastStates[jobName].complete, states[jobName].complete, `complete count from monitor-states doesn't match`);

          finished();
        });

      });

  });

});
