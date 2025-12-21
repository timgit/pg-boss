import { expect } from 'vitest'
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

    expect(Object.keys(options).length).toBe(0)
  })

  it('createQueue should work if queue already exists', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema)
    await testContext.boss.createQueue(testContext.schema)
  })

  it('should reject a queue with invalid characters', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    const queue = `*${testContext.bossConfig.schema}`
    await expect(async () => {
      await testContext.boss!.createQueue(queue)
    }).rejects.toThrow()
  })

  it('should reject a queue with invalid policy', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    await expect(async () => {
      // @ts-ignore
      await testContext.boss.createQueue(testContext.schema, { policy: 'something' })
    }).rejects.toThrow()
  })

  it('should reject using a queue if not created', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    await expect(async () => {
      await testContext.boss!.send(testContext.schema)
    }).rejects.toThrow()
  })

  it('should create a queue with standard policy', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema, { policy: 'standard' })
  })

  it('should delete and then create a queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema)
    expect(await testContext.boss.getQueue(testContext.schema)).toBeTruthy()
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
    expect(queuedCount).toBeTruthy()
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

    expect(count1 + count2).toBe(0)
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

    expect(await getCount()).toBe(1)

    await testContext.boss.deleteQueuedJobs(testContext.schema)

    expect(await getCount()).toBe(0)
  })

  it('should delete all stored jobs from a queue', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const { completed, failed, cancelled } = states
    const inClause = [completed, failed, cancelled].map(s => `'${s}'`)
    const getCount = () => helper.countJobs(testContext.bossConfig.schema, 'job', `state IN (${inClause})`)

    await testContext.boss.send(testContext.schema)
    const [job1] = await testContext.boss.fetch(testContext.schema)
    expect(job1?.id).toBeTruthy()

    await testContext.boss.complete(testContext.schema, job1.id)

    expect(await getCount()).toBe(1)

    await testContext.boss.send(testContext.schema, null, { retryLimit: 0 })
    const [job2] = await testContext.boss.fetch(testContext.schema)
    await testContext.boss.fail(testContext.schema, job2.id)

    expect(await getCount()).toBe(2)

    await testContext.boss.deleteStoredJobs(testContext.schema)

    expect(await getCount()).toBe(0)
  })

  it('getQueue() returns null when missing', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    const queue = await testContext.boss.getQueue(testContext.bossConfig.schema)
    expect(queue).toBe(null)
  })

  it('getQueues() returns queues array', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    const queue1 = `${testContext.bossConfig.schema}_1`
    const queue2 = `${testContext.bossConfig.schema}_2`

    await testContext.boss.createQueue(queue1)
    await testContext.boss.createQueue(queue2)

    const queues = await testContext.boss.getQueues()

    expect(queues.length).toBe(2)

    expect(queues.some(q => q.name === queue1)).toBeTruthy()
    expect(queues.some(q => q.name === queue2)).toBeTruthy()
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

    expect(queueObj).toBeTruthy()

    expect(queueObj!.name).toBe(testContext.schema)
    expect(queueObj!.policy).toBe(createProps.policy)
    expect(queueObj!.retryLimit).toBe(createProps.retryLimit)
    expect(queueObj!.retryBackoff).toBe(createProps.retryBackoff)
    expect(queueObj!.retryDelay).toBe(createProps.retryDelay)
    expect(queueObj!.retryDelayMax).toBe(createProps.retryDelayMax)
    expect(queueObj!.expireInSeconds).toBe(createProps.expireInSeconds)
    expect(queueObj!.retentionSeconds).toBe(createProps.retentionSeconds)
    expect(queueObj!.deadLetter).toBe(createProps.deadLetter)
    expect(queueObj!.createdOn).toBeTruthy()
    expect(queueObj!.updatedOn).toBeTruthy()

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

    expect(queueObj!.retryLimit).toBe(updateProps.retryLimit)
    expect(queueObj!.retryBackoff).toBe(updateProps.retryBackoff)
    expect(queueObj!.retryDelay).toBe(updateProps.retryDelay)
    expect(queueObj!.expireInSeconds).toBe(updateProps.expireInSeconds)
    expect(queueObj!.deadLetter).toBe(updateProps.deadLetter)
  })

  it('should fail to change queue policy', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema, { policy: 'standard' })

    await expect(async () => {
      // @ts-ignore
      await testContext.boss.updateQueue(testContext.schema, { policy: 'exclusive' })
    }).rejects.toThrow()
  })

  it('should fail to change queue partitioning', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
    await testContext.boss.createQueue(testContext.schema, { partition: true })

    await expect(async () => {
      // @ts-ignore
      await testContext.boss.updateQueue(testContext.schema, { partition: false })
    }).rejects.toThrow()
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

    expect(job).toBeTruthy()

    const retentionSeconds = (new Date(job!.keepUntil).getTime() - new Date(job!.createdOn).getTime()) / 1000

    expect(job!.retryLimit).toBe(createProps.retryLimit)
    expect(job!.retryBackoff).toBe(createProps.retryBackoff)
    expect(job!.retryDelay).toBe(createProps.retryDelay)
    expect(job!.retryDelayMax).toBe(createProps.retryDelayMax)
    expect(job!.deadLetter).toBe(createProps.deadLetter)
    expect(job!.expireInSeconds).toBe(createProps.expireInSeconds)
    expect(retentionSeconds).toBe(createProps.retentionSeconds)
  })
})
