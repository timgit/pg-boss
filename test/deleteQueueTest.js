const assert = require('assert')
const helper = require('./testHelper')

describe('deleteQueue', function () {
  it('should clear a specific queue', async function () {
    const queue1 = 'delete-named-queue-1'
    const queue2 = 'delete-named-queue-2'

    const config = this.test.bossConfig
    const boss = await helper.start(config)

    const countJobs = queue => helper.countJobs(config.schema, 'name = $1', [queue])

    await boss.publish(queue1)
    await boss.publish(queue2)

    const q1Count1 = await countJobs(queue1)
    const q2Count1 = await countJobs(queue2)

    assert.strictEqual(1, q1Count1)
    assert.strictEqual(1, q2Count1)

    await boss.deleteQueue(queue1)

    const q1Count2 = await countJobs(queue1)
    const q2Count2 = await countJobs(queue2)

    assert.strictEqual(0, q1Count2)
    assert.strictEqual(1, q2Count2)

    await boss.deleteQueue(queue2)

    const q2Count3 = await countJobs(queue2)

    assert.strictEqual(0, q2Count3)

    await boss.stop()
  })

  it('should clear all queues', async function () {
    const queue1 = 'delete-named-queue-11'
    const queue2 = 'delete-named-queue-22'

    const config = this.test.bossConfig
    const boss = await helper.start(config)
    const countJobs = queue => helper.countJobs(config.schema, 'name = $1', [queue])

    await boss.publish(queue1)
    await boss.publish(queue2)

    const q1Count1 = await countJobs(queue1)
    const q2Count1 = await countJobs(queue2)

    assert.strictEqual(1, q1Count1)
    assert.strictEqual(1, q2Count1)

    await boss.deleteAllQueues()

    const q1Count2 = await countJobs(queue1)
    const q2Count2 = await countJobs(queue2)

    assert.strictEqual(0, q1Count2)
    assert.strictEqual(0, q2Count2)

    await boss.stop()
  })
})
