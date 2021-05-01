const assert = require('assert')
const helper = require('./testHelper')

describe('priority', function () {
  it('should process a newer higher priority job before an older lower priority job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const jobName = 'priority-test'

    await boss.publish(jobName)

    const high = await boss.publish(jobName, null, { priority: 1 })

    const job = await boss.fetch(jobName)

    assert.strictEqual(job.id, high)
  })

  it('should process several jobs in descending priority order', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'multiple-priority-test'

    const low = await boss.publish(queue, null, { priority: 1 })
    const medium = await boss.publish(queue, null, { priority: 5 })
    const high = await boss.publish(queue, null, { priority: 10 })

    const job1 = await boss.fetch(queue)
    const job2 = await boss.fetch(queue)
    const job3 = await boss.fetch(queue)

    assert.strictEqual(job1.id, high)
    assert.strictEqual(job2.id, medium)
    assert.strictEqual(job3.id, low)
  })
})
