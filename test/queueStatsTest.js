import assert from 'node:assert'
import * as helper from './testHelper.js'

describe('queueStats', function () {
  let boss
  const queue1 = helper.randomQueueName()
  const queue2 = helper.randomQueueName()

  before(async function () {
    boss = this.test.boss = await helper.start(this.test.bossConfig)

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    await boss.send(queue1)
    await boss.send(queue1)
    await boss.send(queue2)
    await boss.send(queue2)
  })

  it('should get accurate stats', async function () {
    const queueData = await boss.getQueueStats(queue1)
    assert.notEqual(queueData, undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      activeCount,
      totalCount
    } = queueData

    assert.equal(name, queue1)
    assert.equal(deferredCount, 0)
    assert.equal(queuedCount, 2)
    assert.equal(activeCount, 0)
    assert.equal(totalCount, 2)
  })

  it('should get accurate stats on an empty queue', async function () {
    const queue3 = helper.randomQueueName()
    await boss.createQueue(queue3)

    const queueData = await boss.getQueueStats(queue3)
    assert.notEqual(queueData, undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      activeCount,
      totalCount
    } = queueData

    assert.equal(name, queue3)
    assert.equal(deferredCount, 0)
    assert.equal(queuedCount, 0)
    assert.equal(activeCount, 0)
    assert.equal(totalCount, 0)
  })
})
