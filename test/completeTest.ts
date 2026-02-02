import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { states } from '../src/index.ts'
import { ctx } from './hooks.ts'

describe('complete', function () {
  it('should reject missing id argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.complete(ctx.schema)
    }).rejects.toThrow()
  })

  it('should complete a batch of jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const batchSize = 3

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const { table } = (await ctx.boss.getQueue(ctx.schema))!

    const countJobs = (state: string) => helper.countJobs(ctx.schema, table, 'name = $1 AND state = $2', [ctx.schema, state])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize })

    const activeCount = await countJobs(states.active)

    expect(activeCount).toBe(batchSize)

    const result = await ctx.boss.complete(ctx.schema, jobs.map(job => job.id))

    expect(result.jobs.length).toBe(batchSize)
  })

  it('should store job output in job.output from complete()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.id).toBe(jobId)

    const completionData = { msg: 'i am complete' }

    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId, completionData)

    const jobWithMetadata = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(jobWithMetadata).toBeTruthy()

    expect((jobWithMetadata as any).output.msg).toBe(completionData.msg)
  })

  it('should store job error in job.output from fail()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.id).toBe(jobId)

    const completionError = new Error('i am complete')

    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId, completionError)

    const jobWithMetadata = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(jobWithMetadata).toBeTruthy()

    expect((jobWithMetadata as any).output.message).toBe(completionError.message)
  })

  it('should complete a batch of jobs with custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const batchSize = 3

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const { table } = (await ctx.boss.getQueue(ctx.schema))!

    const countJobs = (state: string) => helper.countJobs(ctx.schema, table, 'name = $1 AND state = $2', [ctx.schema, state])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize })

    const activeCount = await countJobs(states.active)

    expect(activeCount).toBe(batchSize)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return (_db as any).pool.query(sql, values)
      }
    }

    const result = await ctx.boss.complete(ctx.schema, jobs.map(job => job.id), undefined, { db })

    expect(result.jobs.length).toBe(batchSize)
    expect(called).toBe(true)
  })

  it('should complete a created job with includeQueued option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema)

    assertTruthy(jobId)

    const completionData = { msg: 'completed without fetching' }
    const result = await ctx.boss.complete(ctx.schema, jobId, completionData, { includeQueued: true })

    expect(result.affected).toBe(1)

    const jobWithMetadata = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(jobWithMetadata).toBeTruthy()
    expect(jobWithMetadata?.state).toBe(states.completed)
    expect((jobWithMetadata as any).output.msg).toBe(completionData.msg)
  })

  it('should complete a retry job with includeQueued option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, {}, { retryLimit: 2 })
    assertTruthy(jobId)

    // Fetch and fail the job to move it to retry state
    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId, new Error('test failure'))

    const jobWithMetadata = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(jobWithMetadata?.state).toBe(states.retry)

    // Complete the job in retry state
    const completionData = { msg: 'completed from retry' }
    const result = await ctx.boss.complete(ctx.schema, jobId, completionData, { includeQueued: true })

    expect(result.affected).toBe(1)

    const completedJob = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(completedJob?.state).toBe(states.completed)
    expect((completedJob as any).output.msg).toBe(completionData.msg)
  })

  it('should not complete created job without includeQueued option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    // Try to complete without fetching (default behavior)
    const result = await ctx.boss.complete(ctx.schema, jobId)

    expect(result.affected).toBe(0)

    const jobWithMetadata = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(jobWithMetadata?.state).toBe(states.created)
  })

  it('should complete batch with mixed states when includeQueued is true', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // Create 3 jobs
    const jobId1 = await ctx.boss.send(ctx.schema, {}, { retryLimit: 2 })
    const jobId2 = await ctx.boss.send(ctx.schema, {}, { retryLimit: 2 })
    const jobId3 = await ctx.boss.send(ctx.schema)

    assertTruthy(jobId1)
    assertTruthy(jobId2)
    assertTruthy(jobId3)

    // Fetch and fail first job to move it to retry state
    const [job1] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, job1.id, new Error('test'))

    // Fetch second job to move it to active state
    await ctx.boss.fetch(ctx.schema)

    // Third job remains in created state

    // Complete all three with includeQueued
    const result = await ctx.boss.complete(ctx.schema, [jobId1, jobId2, jobId3], undefined, { includeQueued: true })

    expect(result.affected).toBe(3)

    const job1Final = await ctx.boss.getJobById(ctx.schema, jobId1)
    const job2Final = await ctx.boss.getJobById(ctx.schema, jobId2)
    const job3Final = await ctx.boss.getJobById(ctx.schema, jobId3)

    expect(job1Final?.state).toBe(states.completed) // was retry
    expect(job2Final?.state).toBe(states.completed) // was active
    expect(job3Final?.state).toBe(states.completed) // was created
  })
})
