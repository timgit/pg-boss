import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { states } from '../src/index.ts'
import { ctx } from './hooks.ts'

describe('queues', function () {
  it('should create a queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
  })

  it('should not add a policy property when creating a queue if it is missing', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const options = {}

    await ctx.boss.createQueue(ctx.schema, options)

    expect(Object.keys(options).length).toBe(0)
  })

  it('createQueue should work if queue already exists', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.createQueue(ctx.schema)
  })

  it('should reject a queue with invalid characters', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = `*${ctx.bossConfig.schema}`
    await expect(async () => {
      await ctx.boss!.createQueue(queue)
    }).rejects.toThrow()
  })

  it('should reject a queue with invalid policy', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.createQueue(ctx.schema, { policy: 'something' })
    }).rejects.toThrow()
  })

  it('should reject using a queue if not created', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await expect(async () => {
      await ctx.boss!.send(ctx.schema)
    }).rejects.toThrow()
  })

  it('should create a queue with standard policy', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'standard' })
  })

  it('should delete and then create a queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    expect(await ctx.boss.getQueue(ctx.schema)).toBeTruthy()
    await ctx.boss.deleteQueue(ctx.schema)
    await ctx.boss.createQueue(ctx.schema)
  })

  it('should delete an empty queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.deleteAllJobs(ctx.schema)
    await ctx.boss.deleteQueue(ctx.schema)
  })

  it('should truncate a partitioned queue and leave other queues alone', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queue2 = `${ctx.schema}2`
    await ctx.boss.createQueue(queue2)
    await ctx.boss.send(queue2)

    await ctx.boss.createQueue(ctx.schema, { partition: true })
    await ctx.boss.send(ctx.schema)

    await ctx.boss.deleteAllJobs(ctx.schema)
    await ctx.boss.deleteQueue(ctx.schema)

    const { queuedCount } = await ctx.boss.getQueueStats(queue2)
    expect(queuedCount).toBeTruthy()
  })

  it('should truncate a partitioned queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { partition: true })
    await ctx.boss.send(ctx.schema)
    await ctx.boss.deleteAllJobs(ctx.schema)
    await ctx.boss.deleteQueue(ctx.schema)
  })

  it('should delete all jobs from all queues, included partitioned', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { partition: true })
    await ctx.boss.send(ctx.schema)

    const queue2 = `${ctx.schema}2`
    await ctx.boss.createQueue(queue2)
    await ctx.boss.send(queue2)

    await ctx.boss.deleteAllJobs()

    const { queuedCount: count1 } = await ctx.boss.getQueueStats(ctx.schema)
    const { queuedCount: count2 } = await ctx.boss.getQueueStats(queue2)

    expect(count1 + count2).toBe(0)
  })

  it('should delete a non-empty queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.deleteQueue(ctx.schema)
  })

  it('should delete all queued jobs from a queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const getCount = () => helper.countJobs(ctx.bossConfig.schema, 'job', 'state = $1', [states.created])

    await ctx.boss.send(ctx.schema)

    expect(await getCount()).toBe(1)

    await ctx.boss.deleteQueuedJobs(ctx.schema)

    expect(await getCount()).toBe(0)
  })

  it('should delete all stored jobs from a queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const { completed, failed, cancelled } = states
    const inClause = [completed, failed, cancelled].map(s => `'${s}'`)
    const getCount = () => helper.countJobs(ctx.bossConfig.schema, 'job', `state IN (${inClause})`)

    await ctx.boss.send(ctx.schema)
    const [job1] = await ctx.boss.fetch(ctx.schema)
    expect(job1?.id).toBeTruthy()

    await ctx.boss.complete(ctx.schema, job1.id)

    expect(await getCount()).toBe(1)

    await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })
    const [job2] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, job2.id)

    expect(await getCount()).toBe(2)

    await ctx.boss.deleteStoredJobs(ctx.schema)

    expect(await getCount()).toBe(0)
  })

  it('getQueue() returns null when missing', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = await ctx.boss.getQueue(ctx.bossConfig.schema)
    expect(queue).toBe(null)
  })

  it('getQueues() returns queues array', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue1 = `${ctx.bossConfig.schema}_1`
    const queue2 = `${ctx.bossConfig.schema}_2`

    await ctx.boss.createQueue(queue1)
    await ctx.boss.createQueue(queue2)

    const queues = await ctx.boss.getQueues()

    expect(queues.length).toBe(2)

    expect(queues.some(q => q.name === queue1)).toBeTruthy()
    expect(queues.some(q => q.name === queue2)).toBeTruthy()
  })

  it('should update queue properties', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    let deadLetter = `${ctx.schema}_dlq1`
    await ctx.boss.createQueue(deadLetter)

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

    await ctx.boss.createQueue(ctx.schema, createProps)

    let queueObj = await ctx.boss.getQueue(ctx.schema)

    expect(queueObj).toBeTruthy()

    expect(queueObj!.name).toBe(ctx.schema)
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

    deadLetter = `${ctx.schema}_dlq2`
    await ctx.boss.createQueue(deadLetter)

    const updateProps = {
      retryDelay: 2,
      retryLimit: 2,
      retryBackoff: false,
      expireInSeconds: 2,
      deadLetter
    }

    await ctx.boss.updateQueue(ctx.schema, updateProps)

    queueObj = await ctx.boss.getQueue(ctx.schema)

    expect(queueObj!.retryLimit).toBe(updateProps.retryLimit)
    expect(queueObj!.retryBackoff).toBe(updateProps.retryBackoff)
    expect(queueObj!.retryDelay).toBe(updateProps.retryDelay)
    expect(queueObj!.expireInSeconds).toBe(updateProps.expireInSeconds)
    expect(queueObj!.deadLetter).toBe(updateProps.deadLetter)
  })

  it('should fail to change queue policy', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'standard' })

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.updateQueue(ctx.schema, { policy: 'exclusive' })
    }).rejects.toThrow()
  })

  it('should fail to change queue partitioning', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { partition: true })

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.updateQueue(ctx.schema, { partition: false })
    }).rejects.toThrow()
  })

  it('jobs should inherit properties from queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)

    const createProps = {
      retryLimit: 1,
      retryBackoff: true,
      retryDelay: 2,
      retryDelayMax: 3,
      expireInSeconds: 4,
      retentionSeconds: 4,
      deadLetter
    }

    await ctx.boss.createQueue(ctx.schema, createProps)

    const jobId = await ctx.boss.send(ctx.schema)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)

    const retentionSeconds = (new Date(job.keepUntil).getTime() - new Date(job.createdOn).getTime()) / 1000

    expect(job.retryLimit).toBe(createProps.retryLimit)
    expect(job.retryBackoff).toBe(createProps.retryBackoff)
    expect(job.retryDelay).toBe(createProps.retryDelay)
    expect(job.retryDelayMax).toBe(createProps.retryDelayMax)
    expect(job.deadLetter).toBe(createProps.deadLetter)
    expect(job.expireInSeconds).toBe(createProps.expireInSeconds)
    expect(retentionSeconds).toBe(createProps.retentionSeconds)
  })
})
