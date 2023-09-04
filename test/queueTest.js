const assert = require('assert')
const helper = require('./testHelper')

describe('queues', function () {
  it('should create a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
  })

  it('should reject a queue with invalid characters', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = `*${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue that starts with a number', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = `4${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue with invalid policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    try {
      await boss.createQueue(queue, { policy: 'something' })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should create a queue with standard policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'standard' })
  })

  it('should create a queue with stately policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })
  })

  it('should create a queue with singleton policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })
  })

  it('should create a queue with short policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })
  })

  it('should create a queue with priority policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'priority' })
  })

  it('should delete a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.deleteQueue(queue)
  })

  it('should purge a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.purgeQueue(queue)
  })

  it.skip('should update queue properties', async function () {

  })

  it.skip('jobs should inherit properties from queue', async function () {

  })

  it('short policy only allows 1 job in queue', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })

    const jobId = await boss.send(queue)

    assert(jobId)

    const jobId2 = await boss.send(queue)

    assert.strictEqual(jobId2, null)

    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    const jobId3 = await boss.send(queue)

    assert(jobId3)
  })

  it('singleton policy only allows 1 active job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })

    await boss.send(queue)

    await boss.send(queue)

    const job1 = await boss.fetch(queue)

    const job2 = await boss.fetch(queue)

    assert.strictEqual(job2, null)

    await boss.complete(job1.id)

    const job3 = await boss.fetch(queue)

    assert(job3)
  })

  it('stately policy only allows 1 job per state up to active', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })

    const jobId1 = await boss.send(queue, null, { retryLimit: 1 })

    const blockedId = await boss.send(queue)

    assert.strictEqual(blockedId, null)

    let job1 = await boss.fetch(queue)

    await boss.fail(job1.id)

    job1 = await boss.getJobById(jobId1)

    assert.strictEqual(job1.state, 'retry')

    const jobId2 = await boss.send(queue, null, { retryLimit: 1 })

    assert(jobId2)

    job1 = await boss.fetch(queue)

    job1 = await boss.getJobById(jobId1)

    assert.strictEqual(job1.state, 'active')

    const blockedSecondActive = await boss.fetch(queue)

    assert.strictEqual(blockedSecondActive, null)
  })

  it('should clear a specific queue', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue1 = `${this.test.bossConfig.schema}1`
    const queue2 = `${this.test.bossConfig.schema}2`

    await boss.send(queue1)
    await boss.send(queue2)

    const q1Count1 = await boss.getQueueSize(queue1)
    const q2Count1 = await boss.getQueueSize(queue2)

    assert.strictEqual(1, q1Count1)
    assert.strictEqual(1, q2Count1)

    await boss.purgeQueue(queue1)

    const q1Count2 = await boss.getQueueSize(queue1)
    const q2Count2 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q1Count2)
    assert.strictEqual(1, q2Count2)

    await boss.purgeQueue(queue2)

    const q2Count3 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q2Count3)
  })
})
