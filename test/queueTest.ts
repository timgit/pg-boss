import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { states } from '../src/index.ts'
import { testContext } from './hooks.ts'

describe('queues', function () {
  it('should create a queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema)
  })

  it('should not add a policy property when creating a queue if it is missing', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    const options = {}

    await testContext.boss.createQueue(testContext.schema, options)

    assert.strictEqual(Object.keys(options).length, 0)
  })

  it('createQueue should work if queue already exists', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema)
    await testContext.boss.createQueue(testContext.schema)
  })

  it('should reject a queue with invalid characters', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    const queue = `*${testContext.bossConfig.schema}`
    await assert.rejects(async () => {
      await testContext.boss!.createQueue(queue)
    })
  })

  it('should reject a queue with invalid policy', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.createQueue(testContext.schema, { policy: 'something' })
    })
  })

  it('should reject using a queue if not created', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    await assert.rejects(async () => {
      await testContext.boss!.send(testContext.schema)
    })
  })

  it('should create a queue with standard policy', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema, { policy: 'standard' })
  })

  it('should delete and then create a queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema)
    assert(await testContext.boss.getQueue(testContext.schema))
    await testContext.boss.deleteQueue(testContext.schema)
    await testContext.boss.createQueue(testContext.schema)
  })

  it('should delete an empty queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema)
    await testContext.boss.send(testContext.schema)
    await testContext.boss.deleteAllJobs(testContext.schema)
    await testContext.boss.deleteQueue(testContext.schema)
  })

  it('should truncate a partitioned queue and leave other queues alone', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    const queue2 = `${testContext.schema}2`
    await testContext.boss.createQueue(queue2)
    await testContext.boss.send(queue2)

    await testContext.boss.createQueue(testContext.schema, { partition: true })
    await testContext.boss.send(testContext.schema)

    await testContext.boss.deleteAllJobs(testContext.schema)
    await testContext.boss.deleteQueue(testContext.schema)

    const { queuedCount } = await testContext.boss.getQueueStats(queue2)
    assert(queuedCount)
  })

  it('should truncate a partitioned queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema, { partition: true })
    await testContext.boss.send(testContext.schema)
    await testContext.boss.deleteAllJobs(testContext.schema)
    await testContext.boss.deleteQueue(testContext.schema)
  })

  it('should delete all jobs from all queues, included partitioned', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema, { partition: true })
    await testContext.boss.send(testContext.schema)

    const queue2 = `${testContext.schema}2`
    await testContext.boss.createQueue(queue2)
    await testContext.boss.send(queue2)

    await testContext.boss.deleteAllJobs()

    const { queuedCount: count1 } = await testContext.boss.getQueueStats(testContext.schema)
    const { queuedCount: count2 } = await testContext.boss.getQueueStats(queue2)

    assert.strictEqual(count1 + count2, 0)
  })

  it('should delete a non-empty queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema)
    await testContext.boss.send(testContext.schema)
    await testContext.boss.deleteQueue(testContext.schema)
  })

  it('should delete all queued jobs from a queue', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const getCount = () => helper.countJobs(testContext.bossConfig.schema, 'job', 'state = $1', [states.created])

    await testContext.boss.send(testContext.schema)

    assert.strictEqual(await getCount(), 1)

    await testContext.boss.deleteQueuedJobs(testContext.schema)

    assert.strictEqual(await getCount(), 0)
  })

  it('should delete all stored jobs from a queue', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const { completed, failed, cancelled } = states
    const inClause = [completed, failed, cancelled].map(s => `'${s}'`)
    const getCount = () => helper.countJobs(testContext.bossConfig.schema, 'job', `state IN (${inClause})`)

    await testContext.boss.send(testContext.schema)
    const [job1] = await testContext.boss.fetch(testContext.schema)
    assert(job1?.id)

    await testContext.boss.complete(testContext.schema, job1.id)

    assert.strictEqual(await getCount(), 1)

    await testContext.boss.send(testContext.schema, null, { retryLimit: 0 })
    const [job2] = await testContext.boss.fetch(testContext.schema)
    await testContext.boss.fail(testContext.schema, job2.id)

    assert.strictEqual(await getCount(), 2)

    await testContext.boss.deleteStoredJobs(testContext.schema)

    assert.strictEqual(await getCount(), 0)
  })

  it('getQueue() returns null when missing', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    const queue = await testContext.boss.getQueue(testContext.bossConfig.schema)
    assert.strictEqual(queue, null)
  })

  it('getQueues() returns queues array', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    const queue1 = `${testContext.bossConfig.schema}_1`
    const queue2 = `${testContext.bossConfig.schema}_2`

    await testContext.boss.createQueue(queue1)
    await testContext.boss.createQueue(queue2)

    const queues = await testContext.boss.getQueues()

    assert.strictEqual(queues.length, 2)

    assert(queues.some(q => q.name === queue1))
    assert(queues.some(q => q.name === queue2))
  })

  it('should update queue properties', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    let deadLetter = `${testContext.schema}_dlq1`
    await testContext.boss.createQueue(deadLetter)

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

    await testContext.boss.createQueue(testContext.schema, createProps)

    let queueObj = await testContext.boss.getQueue(testContext.schema)

    assert(queueObj)

    assert.strictEqual(testContext.schema, queueObj.name)
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

    deadLetter = `${testContext.schema}_dlq2`
    await testContext.boss.createQueue(deadLetter)

    const updateProps = {
      retryDelay: 2,
      retryLimit: 2,
      retryBackoff: false,
      expireInSeconds: 2,
      deadLetter
    }

    await testContext.boss.updateQueue(testContext.schema, updateProps)

    queueObj = await testContext.boss.getQueue(testContext.schema)

    assert.strictEqual(updateProps.retryLimit, queueObj!.retryLimit)
    assert.strictEqual(updateProps.retryBackoff, queueObj!.retryBackoff)
    assert.strictEqual(updateProps.retryDelay, queueObj!.retryDelay)
    assert.strictEqual(updateProps.expireInSeconds, queueObj!.expireInSeconds)
    assert.strictEqual(updateProps.deadLetter, queueObj!.deadLetter)
  })

  it('should fail to change queue policy', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema, { policy: 'standard' })

    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.updateQueue(testContext.schema, { policy: 'exclusive' })
    })
  })

  it('should fail to change queue partitioning', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    await testContext.boss.createQueue(testContext.schema, { partition: true })

    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.updateQueue(testContext.schema, { partition: false })
    })
  })

  it('jobs should inherit properties from queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    const deadLetter = `${testContext.schema}_dlq`
    await testContext.boss.createQueue(deadLetter)

    const createProps = {
      retryLimit: 1,
      retryBackoff: true,
      retryDelay: 2,
      retryDelayMax: 3,
      expireInSeconds: 4,
      retentionSeconds: 4,
      deadLetter
    }

    await testContext.boss.createQueue(testContext.schema, createProps)

    const jobId = await testContext.boss.send(testContext.schema)

    const job = await testContext.boss.getJobById(testContext.schema, jobId!)

    assert(job)

    const retentionSeconds = (new Date(job.keepUntil).getTime() - new Date(job.createdOn).getTime()) / 1000

    assert.strictEqual(job.retryLimit, createProps.retryLimit)
    assert.strictEqual(job.retryBackoff, createProps.retryBackoff)
    assert.strictEqual(job.retryDelay, createProps.retryDelay)
    assert.strictEqual(job.retryDelayMax, createProps.retryDelayMax)
    assert.strictEqual(job.deadLetter, createProps.deadLetter)
    assert.strictEqual(job.expireInSeconds, createProps.expireInSeconds)
    assert.strictEqual(retentionSeconds, createProps.retentionSeconds)
  })
})
