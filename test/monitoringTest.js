const assert = require('chai').assert
const helper = require('./testHelper')

describe('monitoring', function () {
  this.timeout(10000)

  let boss

  const config = { monitorStateIntervalSeconds: 1, maintenanceIntervalSeconds: 10 }

  before(async () => { boss = await helper.start(config) })
  after(() => boss.stop())

  it('should emit state counts', function (finished) {
    test()

    async function test () {
      const jobName = 'monitorMe'

      await boss.publish(jobName)
      await boss.publish(jobName)

      const states1 = await boss.countStates()

      assert.strictEqual(2, states1.queues[jobName].created, 'created count is wrong after 2 publishes')
      assert.strictEqual(0, states1.queues[jobName].active, 'active count is wrong after 2 publishes')

      await boss.publish(jobName)
      await boss.fetch(jobName)

      const states2 = await boss.countStates()

      assert.strictEqual(2, states2.queues[jobName].created, 'created count is wrong after 3 publishes and 1 fetch')
      assert.strictEqual(1, states2.queues[jobName].active, 'active count is wrong after 3 publishes and 1 fetch')

      await boss.fetch(jobName)
      const states3 = await boss.countStates()

      assert.strictEqual(1, states3.queues[jobName].created, 'created count is wrong after 3 publishes and 2 fetches')
      assert.strictEqual(2, states3.queues[jobName].active, 'active count is wrong after 3 publishes and 2 fetches')

      const job = await boss.fetch(jobName)
      await boss.complete(job.id)

      const states4 = await boss.countStates()

      assert.strictEqual(0, states4.queues[jobName].created, 'created count is wrong after 3 publishes and 3 fetches and 1 complete')
      assert.strictEqual(2, states4.queues[jobName].active, 'active count is wrong after 3 publishes and 3 fetches and 1 complete')
      assert.strictEqual(1, states4.queues[jobName].completed, 'completed count is wrong after 3 publishes and 3 fetches and 1 complete')

      boss.on('monitor-states', states => {
        assert.strictEqual(states4.queues[jobName].created, states.queues[jobName].created, 'created count from monitor-states doesn\'t match')
        assert.strictEqual(states4.queues[jobName].active, states.queues[jobName].active, 'active count from monitor-states doesn\'t match')
        assert.strictEqual(states4.queues[jobName].completed, states.queues[jobName].completed, 'completed count from monitor-states doesn\'t match')

        console.log('monitor-states emitted')
        finished()
      })
    }
  })

  // it('should emit an error if an error happens during state monitoring', function (finished) {
  //   boss.on('error', () => finished())
  //   helper.getDb().executeSql('DROP TABLE pgboss.job')
  // })
})
