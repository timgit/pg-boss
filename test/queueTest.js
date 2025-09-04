const assert = require('node:assert')
const helper = require('./testHelper')

describe('queues', function () {
  it('should create a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
  })

  it('createQueue should work if queue already exists', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.createQueue(queue)
  })

  it('should reject a queue with invalid characters', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = `*${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue that starts with a number', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = `4${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue with invalid policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    try {
      await boss.createQueue(queue, { policy: 'something' })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should create a queue with standard policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'standard' })
  })

  it('should create a queue with stately policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })
  })

  it('should create a queue with exactly_once policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'exactly_once' })
  })

  it('should create a queue with singleton policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })
  })

  it('should create a queue with short policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })
  })

  it('should delete and then create a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    assert(await boss.getQueue(queue))
    await boss.deleteQueue(queue)
    await boss.createQueue(queue)
  })

  it('should purge a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.purgeQueue(queue)
  })

  it('getQueue() returns null when missing', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = await boss.getQueue(this.test.bossConfig.schema)
    assert.strictEqual(queue, null)
  })

  it('getQueues() returns queues array', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue1 = `${this.test.bossConfig.schema}_1`
    const queue2 = `${this.test.bossConfig.schema}_2`

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    const queues = await boss.getQueues()

    assert.strictEqual(queues.length, 2)

    assert(queues.some(q => q.name === queue1))
    assert(queues.some(q => q.name === queue2))
  })

  it('should update queue properties', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    let deadLetter = `${queue}_dlq1`
    await boss.createQueue(deadLetter)

    const createProps = {
      policy: 'standard',
      retryLimit: 1,
      retryBackoff: false,
      retryDelay: 1,
      expireInSeconds: 1,
      retentionMinutes: 1,
      deadLetter
    }

    await boss.createQueue(queue, createProps)

    let queueObj = await boss.getQueue(queue)

    assert.strictEqual(queue, queueObj.name)
    assert.strictEqual(createProps.policy, queueObj.policy)
    assert.strictEqual(createProps.retryLimit, queueObj.retryLimit)
    assert.strictEqual(createProps.retryBackoff, queueObj.retryBackoff)
    assert.strictEqual(createProps.retryDelay, queueObj.retryDelay)
    assert.strictEqual(createProps.expireInSeconds, queueObj.expireInSeconds)
    assert.strictEqual(createProps.retentionMinutes, queueObj.retentionMinutes)
    assert.strictEqual(createProps.deadLetter, queueObj.deadLetter)
    assert(queueObj.createdOn)
    assert(queueObj.updatedOn)

    deadLetter = `${queue}_dlq2`
    await boss.createQueue(deadLetter)

    const updateProps = {
      policy: 'short',
      retryLimit: 2,
      retryBackoff: true,
      retryDelay: 2,
      expireInSeconds: 2,
      retentionMinutes: 2,
      deadLetter
    }

    await boss.updateQueue(queue, updateProps)

    queueObj = await boss.getQueue(queue)

    assert.strictEqual(updateProps.policy, queueObj.policy)
    assert.strictEqual(updateProps.retryLimit, queueObj.retryLimit)
    assert.strictEqual(updateProps.retryBackoff, queueObj.retryBackoff)
    assert.strictEqual(updateProps.retryDelay, queueObj.retryDelay)
    assert.strictEqual(updateProps.expireInSeconds, queueObj.expireInSeconds)
    assert.strictEqual(updateProps.retentionMinutes, queueObj.retentionMinutes)
    assert.strictEqual(updateProps.deadLetter, queueObj.deadLetter)
  })

  it('jobs should inherit properties from queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    const deadLetter = `${queue}_dlq`
    await boss.createQueue(deadLetter)

    const createProps = {
      retryLimit: 1,
      retryBackoff: true,
      retryDelay: 2,
      expireInSeconds: 3,
      retentionMinutes: 4,
      deadLetter
    }

    await boss.createQueue(queue, createProps)

    const jobId = await boss.send(queue)

    const job = await boss.getJobById(queue, jobId)

    const retentionMinutes = (new Date(job.keepUntil) - new Date(job.createdOn)) / 1000 / 60

    assert.strictEqual(createProps.retryLimit, job.retryLimit)
    assert.strictEqual(createProps.retryBackoff, job.retryBackoff)
    assert.strictEqual(createProps.retryDelay, job.retryDelay)
    assert.strictEqual(createProps.expireInSeconds, job.expireIn.seconds)
    assert.strictEqual(createProps.retentionMinutes, retentionMinutes)
    assert.strictEqual(createProps.deadLetter, job.deadLetter)
  })

  it('short policy only allows 1 job in queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })

    const jobId = await boss.send(queue)

    assert(jobId)

    const jobId2 = await boss.send(queue)

    assert.strictEqual(jobId2, null)

    const [job] = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    const jobId3 = await boss.send(queue)

    assert(jobId3)
  })

  it('short policy should be extended with singletonKey', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })

    const jobId = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonKey: 'a' })

    assert.strictEqual(jobId2, null)

    const jobId3 = await boss.send(queue, null, { singletonKey: 'b' })

    assert(jobId3)

    const [job] = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    const jobId4 = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobId4)
  })

  it('singleton policy only allows 1 active job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })

    await boss.send(queue)

    await boss.send(queue)

    const [job1] = await boss.fetch(queue)

    const [job2] = await boss.fetch(queue)

    assert(!job2)

    await boss.complete(queue, job1.id)

    const [job3] = await boss.fetch(queue)

    assert(job3)
  })

  it('singleton policy should be extended with singletonKey', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })

    await boss.send(queue, null, { singletonKey: 'a' })

    await boss.send(queue, null, { singletonKey: 'b' })

    const [job1] = await boss.fetch(queue)

    assert(job1)

    const [job2] = await boss.fetch(queue)

    assert(job2)

    await boss.send(queue, null, { singletonKey: 'b' })

    const [job3] = await boss.fetch(queue)

    assert(!job3)

    await boss.complete(queue, job2.id)

    const [job3b] = await boss.fetch(queue)

    assert(job3b)
  })

  it('stately policy only allows 1 job per state up to active', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })

    const jobId1 = await boss.send(queue, null, { retryLimit: 1 })

    const blockedId = await boss.send(queue)

    assert.strictEqual(blockedId, null)

    let [job1] = await boss.fetch(queue)

    await boss.fail(queue, job1.id)

    job1 = await boss.getJobById(queue, jobId1)

    assert.strictEqual(job1.state, 'retry')

    const jobId2 = await boss.send(queue, null, { retryLimit: 1 })

    assert(jobId2)

    await boss.fetch(queue)

    const job1a = await boss.getJobById(queue, jobId1)

    assert.strictEqual(job1a.state, 'active')

    const [blockedSecondActive] = await boss.fetch(queue)

    assert(!blockedSecondActive)
  })

  it('stately policy fails a job without retry when others are active', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema
    const deadLetter = queue + '_dlq'

    await boss.createQueue(deadLetter)
    await boss.createQueue(queue, { policy: 'stately', deadLetter, retryLimit: 3 })

    const jobId1 = await boss.send(queue, null, { expireInSeconds: 1 })
    await boss.fetch(queue)
    await boss.fail(queue, jobId1)
    const job1Data = await boss.getJobById(queue, jobId1)
    assert.strictEqual(job1Data.state, 'retry')

    // higher priority new job should be active next
    const jobId2 = await boss.send(queue, null, { priority: 1, expireInSeconds: 1 })
    await boss.fetch(queue)

    const jobId3 = await boss.send(queue)
    assert(jobId3)

    await boss.fail(queue, jobId2)

    const job2Data = await boss.getJobById(queue, jobId2)

    assert.strictEqual(job2Data.state, 'failed')

    const [job2Dlq] = await boss.fetch(deadLetter)

    assert(job2Dlq)
  })

  it('stately policy should be extended with singletonKey', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })

    const jobAId = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

    assert(jobAId)

    const jobBId = await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })

    assert(jobBId)

    const jobA2Id = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

    assert.strictEqual(jobA2Id, null)

    let [jobA] = await boss.fetch(queue)

    await boss.fail(queue, jobA.id)

    jobA = await boss.getJobById(queue, jobAId)

    assert.strictEqual(jobA.state, 'retry')

    await boss.fetch(queue)

    jobA = await boss.getJobById(queue, jobAId)

    assert.strictEqual(jobA.state, 'active')

    let [jobB] = await boss.fetch(queue)

    assert(jobB)

    jobB = await boss.getJobById(queue, jobBId)

    assert.strictEqual(jobB.state, 'active')

    const jobA3Id = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobA3Id)

    const [jobA3] = await boss.fetch(queue)

    assert(!jobA3)
  })

  it('should clear a specific queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })

    const queue1 = `${this.test.bossConfig.schema}1`
    const queue2 = `${this.test.bossConfig.schema}2`

    await boss.createQueue(queue1)
    await boss.send(queue1)

    await boss.createQueue(queue2)
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

  it('exactly_once policy only allows 1 active,retry,created job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'exactly_once' })

    const jobId1 = await boss.send(queue, null, { retryLimit: 1 })

    // it won't add a second job while the first is in created state
    const blockedId = await boss.send(queue)

    assert.strictEqual(blockedId, null)

    let [job1] = await boss.fetch(queue)

    await boss.fail(queue, job1.id)

    job1 = await boss.getJobById(queue, jobId1)

    assert.strictEqual(job1.state, 'retry')

    // trying to send another job while one is in retry should not add the job
    const jobId2 = await boss.send(queue, null, { retryLimit: 1 })

    assert.strictEqual(jobId2, null)

    await boss.fetch(queue)

    const job1a = await boss.getJobById(queue, jobId1)

    assert.strictEqual(job1a.state, 'active')

    const [blockedSecondActive] = await boss.fetch(queue)

    assert(!blockedSecondActive)

    // We fail the job again, this time it goes to failed state
    await boss.fail(queue, jobId1)

    // sending a new job should work now that the first job is failed
    const newJobId = await boss.send(queue)
    assert(newJobId)
  })

  it('exactly_once policy should be extended with singletonKey', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'exactly_once' })

    const jobAId = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

    assert(jobAId)

    const jobBId = await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })

    assert(jobBId)

    const jobA2Id = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

    assert.strictEqual(jobA2Id, null)

    let [jobA] = await boss.fetch(queue)

    await boss.fail(queue, jobA.id)

    jobA = await boss.getJobById(queue, jobAId)

    assert.strictEqual(jobA.state, 'retry')

    await boss.fetch(queue)

    jobA = await boss.getJobById(queue, jobAId)

    assert.strictEqual(jobA.state, 'active')

    let [jobB] = await boss.fetch(queue)

    assert(jobB)

    jobB = await boss.getJobById(queue, jobBId)

    assert.strictEqual(jobB.state, 'active')

    // cannot send another 'a' job while one is active
    const jobA3Id = await boss.send(queue, null, { singletonKey: 'a' })

    assert(!jobA3Id)

    const [jobA3] = await boss.fetch(queue)

    assert(!jobA3)
  })
})
