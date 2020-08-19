const assert = require('assert')
const helper = require('./testHelper')

describe('monitoring', function () {
  it('should emit state counts', async function () {
    const defaults = {
      monitorStateIntervalSeconds: 1,
      maintenanceIntervalSeconds: 10
    }

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'monitorMe'

    await boss.publish(queue)
    await boss.publish(queue)

    const states1 = await boss.countStates()

    assert.strictEqual(2, states1.queues[queue].created, 'created count is wrong after 2 publishes')
    assert.strictEqual(0, states1.queues[queue].active, 'active count is wrong after 2 publishes')

    await boss.publish(queue)
    await boss.fetch(queue)

    const states2 = await boss.countStates()

    assert.strictEqual(2, states2.queues[queue].created, 'created count is wrong after 3 publishes and 1 fetch')
    assert.strictEqual(1, states2.queues[queue].active, 'active count is wrong after 3 publishes and 1 fetch')

    await boss.fetch(queue)
    const states3 = await boss.countStates()

    assert.strictEqual(1, states3.queues[queue].created, 'created count is wrong after 3 publishes and 2 fetches')
    assert.strictEqual(2, states3.queues[queue].active, 'active count is wrong after 3 publishes and 2 fetches')

    const job = await boss.fetch(queue)
    await boss.complete(job.id)

    const states4 = await boss.countStates()

    assert.strictEqual(0, states4.queues[queue].created, 'created count is wrong after 3 publishes and 3 fetches and 1 complete')
    assert.strictEqual(2, states4.queues[queue].active, 'active count is wrong after 3 publishes and 3 fetches and 1 complete')
    assert.strictEqual(1, states4.queues[queue].completed, 'completed count is wrong after 3 publishes and 3 fetches and 1 complete')

    return new Promise((resolve, reject) => {
      boss.on('monitor-states', async states => {
        boss.removeAllListeners()

        assert.strictEqual(states4.queues[queue].created, states.queues[queue].created, 'created count from monitor-states doesn\'t match')
        assert.strictEqual(states4.queues[queue].active, states.queues[queue].active, 'active count from monitor-states doesn\'t match')
        assert.strictEqual(states4.queues[queue].completed, states.queues[queue].completed, 'completed count from monitor-states doesn\'t match')

        await boss.stop()

        resolve()
      })
    })
  })
})
