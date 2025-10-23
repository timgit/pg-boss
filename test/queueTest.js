const assert = require('node:assert')
const helper = require('./testHelper')
const { states } = require('../src')

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

  it('should delete and then create a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    assert(await boss.getQueue(queue))
    await boss.deleteQueue(queue)
    await boss.createQueue(queue)
  })

  it('should delete an empty queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.send(queue)
    await boss.deleteAllJobs(queue)
    await boss.deleteQueue(queue)
  })

  it('should truncate queue and leave other queues alone', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    const queue2 = `${queue}2`
    await boss.createQueue(queue2)
    await boss.send(queue2)

    await boss.createQueue(queue)
    await boss.send(queue)

    await boss.deleteAllJobs(queue)
    await boss.deleteQueue(queue)

    const { queuedCount } = await boss.getQueueStats(queue)
    assert.strictEqual(queuedCount, 0)
    const { queuedCount: queued2Count } = await boss.getQueueStats(queue2)
    assert.strictEqual(queued2Count, 1)
  })

  it('should truncate all queues', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    const queue2 = `${queue}2`
    await boss.createQueue(queue2)
    await boss.send(queue2)

    await boss.createQueue(queue)
    await boss.send(queue)

    await boss.deleteAllJobs()

    const { queuedCount } = await boss.getQueueStats(queue)
    assert.strictEqual(queuedCount, 0)
    const { queuedCount: queued2Count } = await boss.getQueueStats(queue2)
    assert.strictEqual(queued2Count, 0)
  })

  it('should truncate a partitioned queue and leave other queues alone', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    const queue2 = `${queue}2`
    await boss.createQueue(queue2)
    await boss.send(queue2)

    await boss.createQueue(queue, { partition: true })
    await boss.send(queue)

    await boss.deleteAllJobs(queue)
    await boss.deleteQueue(queue)

    const { queuedCount } = await boss.getQueueStats(queue2)
    assert(queuedCount)
  })

  it('should truncate a partitioned queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { partition: true })
    await boss.send(queue)
    await boss.deleteAllJobs(queue)
    await boss.deleteQueue(queue)
  })

  it('should delete a non-empty queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.send(queue)

    try {
      await boss.deleteQueue(queue)
    } catch {
      assert(false)
    }
  })

  it('should delete all queued jobs from a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const getCount = () => helper.countJobs(this.test.bossConfig.schema, 'job', 'state = $1', [states.created])

    await boss.send(queue)

    assert.strictEqual(await getCount(), 1)

    await boss.deleteQueuedJobs(queue)

    assert.strictEqual(await getCount(), 0)
  })

  it('should delete all stored jobs from a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const { completed, failed, cancelled } = states
    const inClause = [completed, failed, cancelled].map(s => `'${s}'`)
    const getCount = () => helper.countJobs(this.test.bossConfig.schema, 'job', `state IN (${inClause})`)

    await boss.send(queue)
    const [job1] = await boss.fetch(queue)
    assert(job1?.id)

    await boss.complete(queue, job1.id)

    assert.strictEqual(await getCount(), 1)

    await boss.send(queue, null, { retryLimit: 0 })
    const [job2] = await boss.fetch(queue)
    await boss.fail(queue, job2.id)

    assert.strictEqual(await getCount(), 2)

    await boss.deleteStoredJobs(queue)

    assert.strictEqual(await getCount(), 0)
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
      retryBackoff: true,
      retryDelayMax: 3,
      retryDelay: 1,
      expireInSeconds: 1,
      retentionSeconds: 1,
      deadLetter
    }

    await boss.createQueue(queue, createProps)

    let queueObj = await boss.getQueue(queue)

    assert.strictEqual(queue, queueObj.name)
    assert.strictEqual(createProps.policy, queueObj.policy)
    assert.strictEqual(createProps.retryLimit, queueObj.retryLimit)
    assert.strictEqual(createProps.retryBackoff, queueObj.retryBackoff)
    assert.strictEqual(createProps.retryDelay, queueObj.retryDelay)
    assert.strictEqual(createProps.retryDelayMax, queueObj.retryDelayMax)
    assert.strictEqual(createProps.expireInSeconds, queueObj.expireInSeconds)
    assert.strictEqual(createProps.retentionSeconds, queueObj.retentionSeconds)
    assert.strictEqual(createProps.deadLetter, queueObj.deadLetter)
    assert(queueObj.createdOn)
    assert(queueObj.updatedOn)

    deadLetter = `${queue}_dlq2`
    await boss.createQueue(deadLetter)

    const updateProps = {
      retryDelay: 2,
      retryDelayMax: null,
      retryLimit: 2,
      retryBackoff: false,
      expireInSeconds: 2,
      deadLetter
    }

    await boss.updateQueue(queue, updateProps)

    queueObj = await boss.getQueue(queue)

    assert.strictEqual(updateProps.retryLimit, queueObj.retryLimit)
    assert.strictEqual(updateProps.retryBackoff, queueObj.retryBackoff)
    assert.strictEqual(updateProps.retryDelay, queueObj.retryDelay)
    assert.strictEqual(updateProps.retryDelayMax, queueObj.retryDelayMax)
    assert.strictEqual(updateProps.expireInSeconds, queueObj.expireInSeconds)
    assert.strictEqual(updateProps.deadLetter, queueObj.deadLetter)
  })

  it('should fail to change queue policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'standard' })

    try {
      await boss.updateQueue(queue, { policy: 'exclusive' })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should fail to change queue partitioning', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema
    await boss.createQueue(queue, { partition: true })
    try {
      await boss.updateQueue(queue, { partition: false })
      assert(false)
    } catch (err) {
      assert(true)
    }
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
      retryDelayMax: 3,
      expireInSeconds: 4,
      retentionSeconds: 4,
      deadLetter
    }

    await boss.createQueue(queue, createProps)

    const jobId = await boss.send(queue)

    const job = await boss.getJobById(queue, jobId)

    const retentionSeconds = (new Date(job.keepUntil) - new Date(job.createdOn)) / 1000

    assert.strictEqual(job.retryLimit, createProps.retryLimit)
    assert.strictEqual(job.retryBackoff, createProps.retryBackoff)
    assert.strictEqual(job.retryDelay, createProps.retryDelay)
    assert.strictEqual(job.retryDelayMax, createProps.retryDelayMax)
    assert.strictEqual(job.deadLetter, createProps.deadLetter)
    assert.strictEqual(job.expireInSeconds, createProps.expireInSeconds)
    assert.strictEqual(retentionSeconds, createProps.retentionSeconds)
  })
})
