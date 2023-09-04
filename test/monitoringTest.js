const assert = require('assert')
const helper = require('./testHelper')

describe('monitoring', function () {
  it('should emit state counts', async function () {
    const defaults = {
      supervise: true,
      monitorStateIntervalSeconds: 1
    }

    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'monitorMe'

    await boss.send(queue)
    await boss.send(queue)

    const states1 = await boss.countStates()

    assert.strictEqual(2, states1.queues[queue].created, 'created count is wrong after 2 sendes')
    assert.strictEqual(0, states1.queues[queue].active, 'active count is wrong after 2 sendes')

    await boss.send(queue)
    await boss.fetch(queue)

    const states2 = await boss.countStates()

    assert.strictEqual(2, states2.queues[queue].created, 'created count is wrong after 3 sendes and 1 fetch')
    assert.strictEqual(1, states2.queues[queue].active, 'active count is wrong after 3 sendes and 1 fetch')

    await boss.fetch(queue)
    const states3 = await boss.countStates()

    assert.strictEqual(1, states3.queues[queue].created, 'created count is wrong after 3 sendes and 2 fetches')
    assert.strictEqual(2, states3.queues[queue].active, 'active count is wrong after 3 sendes and 2 fetches')

    const job = await boss.fetch(queue)
    await boss.complete(job.id)

    const states4 = await boss.countStates()

    assert.strictEqual(0, states4.queues[queue].created, 'created count is wrong after 3 sendes and 3 fetches and 1 complete')
    assert.strictEqual(2, states4.queues[queue].active, 'active count is wrong after 3 sendes and 3 fetches and 1 complete')
    assert.strictEqual(1, states4.queues[queue].completed, 'completed count is wrong after 3 sendes and 3 fetches and 1 complete')

    return new Promise((resolve) => {
      let resolved = false

      boss.on('monitor-states', async states => {
        if (!resolved) {
          resolved = true
          assert.strictEqual(states4.queues[queue].created, states.queues[queue].created, 'created count from monitor-states doesn\'t match')
          assert.strictEqual(states4.queues[queue].active, states.queues[queue].active, 'active count from monitor-states doesn\'t match')
          assert.strictEqual(states4.queues[queue].completed, states.queues[queue].completed, 'completed count from monitor-states doesn\'t match')

          resolve()
        }
      })
    })
  })
})
