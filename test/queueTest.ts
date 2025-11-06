import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { states } from '../src/index.ts'

describe('queues', function () {
  it('should create a queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema)
  })

  it('createQueue should work if queue already exists', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema)
    await this.boss.createQueue(this.schema)
  })

  it('should reject a queue with invalid characters', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })
    const queue = `*${this.bossConfig.schema}`

    try {
      await this.boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue that starts with a number', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })
    const queue = `4${this.bossConfig.schema}`

    try {
      await this.boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue with invalid policy', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    try {
      await this.boss.createQueue(this.schema, { policy: 'something' })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should create a queue with standard policy', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema, { policy: 'standard' })
  })

  it('should delete and then create a queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema)
    assert(await this.boss.getQueue(this.schema))
    await this.boss.deleteQueue(this.schema)
    await this.boss.createQueue(this.schema)
  })

  it('should delete an empty queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema)
    await this.boss.send(this.schema)
    await this.boss.deleteAllJobs(this.schema)
    await this.boss.deleteQueue(this.schema)
  })

  it('should truncate a partitioned queue and leave other queues alone', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    const queue2 = `${this.schema}2`
    await this.boss.createQueue(queue2)
    await this.boss.send(queue2)

    await this.boss.createQueue(this.schema, { partition: true })
    await this.boss.send(this.schema)

    await this.boss.deleteAllJobs(this.schema)
    await this.boss.deleteQueue(this.schema)

    const { queuedCount } = await this.boss.getQueueStats(queue2)
    assert(queuedCount)
  })

  it('should truncate a partitioned queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema, { partition: true })
    await this.boss.send(this.schema)
    await this.boss.deleteAllJobs(this.schema)
    await this.boss.deleteQueue(this.schema)
  })

  it('should delete a non-empty queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema)
    await this.boss.send(this.schema)

    try {
      await this.boss.deleteQueue(this.schema)
    } catch {
      assert(false)
    }
  })

  it('should delete all queued jobs from a queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const getCount = () => helper.countJobs(this.bossConfig.schema, 'job', 'state = $1', [states.created])

    await this.boss.send(this.schema)

    assert.strictEqual(await getCount(), 1)

    await this.boss.deleteQueuedJobs(this.schema)

    assert.strictEqual(await getCount(), 0)
  })

  it('should delete all stored jobs from a queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const { completed, failed, cancelled } = states
    const inClause = [completed, failed, cancelled].map(s => `'${s}'`)
    const getCount = () => helper.countJobs(this.bossConfig.schema, 'job', `state IN (${inClause})`)

    await this.boss.send(this.schema)
    const [job1] = await this.boss.fetch(this.schema)
    assert(job1?.id)

    await this.boss.complete(this.schema, job1.id)

    assert.strictEqual(await getCount(), 1)

    await this.boss.send(this.schema, null, { retryLimit: 0 })
    const [job2] = await this.boss.fetch(this.schema)
    await this.boss.fail(this.schema, job2.id)

    assert.strictEqual(await getCount(), 2)

    await this.boss.deleteStoredJobs(this.schema)

    assert.strictEqual(await getCount(), 0)
  })

  it('getQueue() returns null when missing', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })
    const queue = await this.boss.getQueue(this.bossConfig.schema)
    assert.strictEqual(queue, null)
  })

  it('getQueues() returns queues array', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })
    const queue1 = `${this.bossConfig.schema}_1`
    const queue2 = `${this.bossConfig.schema}_2`

    await this.boss.createQueue(queue1)
    await this.boss.createQueue(queue2)

    const queues = await this.boss.getQueues()

    assert.strictEqual(queues.length, 2)

    assert(queues.some(q => q.name === queue1))
    assert(queues.some(q => q.name === queue2))
  })

  it('should update queue properties', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    let deadLetter = `${this.schema}_dlq1`
    await this.boss.createQueue(deadLetter)

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

    await this.boss.createQueue(this.schema, createProps)

    let queueObj = await this.boss.getQueue(this.schema)

    assert.strictEqual(this.schema, queueObj.name)
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

    deadLetter = `${this.schema}_dlq2`
    await this.boss.createQueue(deadLetter)

    const updateProps = {
      retryDelay: 2,
      retryDelayMax: null,
      retryLimit: 2,
      retryBackoff: false,
      expireInSeconds: 2,
      deadLetter
    }

    await this.boss.updateQueue(this.schema, updateProps)

    queueObj = await this.boss.getQueue(this.schema)

    assert.strictEqual(updateProps.retryLimit, queueObj.retryLimit)
    assert.strictEqual(updateProps.retryBackoff, queueObj.retryBackoff)
    assert.strictEqual(updateProps.retryDelay, queueObj.retryDelay)
    assert.strictEqual(updateProps.retryDelayMax, queueObj.retryDelayMax)
    assert.strictEqual(updateProps.expireInSeconds, queueObj.expireInSeconds)
    assert.strictEqual(updateProps.deadLetter, queueObj.deadLetter)
  })

  it('should fail to change queue policy', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema, { policy: 'standard' })

    try {
      await this.boss.updateQueue(this.schema, { policy: 'exclusive' })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should fail to change queue partitioning', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })
    await this.boss.createQueue(this.schema, { partition: true })
    try {
      await this.boss.updateQueue(this.schema, { partition: false })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('jobs should inherit properties from queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    const deadLetter = `${this.schema}_dlq`
    await this.boss.createQueue(deadLetter)

    const createProps = {
      retryLimit: 1,
      retryBackoff: true,
      retryDelay: 2,
      retryDelayMax: 3,
      expireInSeconds: 4,
      retentionSeconds: 4,
      deadLetter
    }

    await this.boss.createQueue(this.schema, createProps)

    const jobId = await this.boss.send(this.schema)

    const job = await this.boss.getJobById(this.schema, jobId)

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
