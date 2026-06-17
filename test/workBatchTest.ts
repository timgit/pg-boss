import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('work batch & completion', function () {
  it('should handle a batch of jobs via batchSize', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await ctx.boss.send(ctx.schema)
    }

    return new Promise<void>((resolve) => {
      ctx.boss!.work(ctx.schema, { batchSize }, async jobs => {
        expect(jobs.length).toBe(batchSize)
        resolve()
      })
    })
  })

  it('batchSize should auto-complete the jobs', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, { batchSize: 1 }, async jobs => {
      expect(jobs.length).toBe(1)
    })

    assertTruthy(jobId)
    const job = await spy.waitForJobWithId(jobId, 'completed')

    expect(job.state).toBe('completed')
  })

  it('returning promise applies backpressure', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobCount = 4
    let processCount = 0

    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    await ctx.boss.work(ctx.schema, async () => {
      // delay slows down process fetch
      await delay(2000)
      processCount++
    })

    await delay(7000)

    expect(processCount).toBeLessThan(jobCount)
  })

  it('completion should pass string wrapped in value prop', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const result = 'success'

    const jobId = await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, async () => result)

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'completed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('completed')
    expect((job.output as { value: string }).value).toBe(result)
  })

  it('handler result should be stored in output', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema)
    await ctx.boss.work(ctx.schema, async () => ({ something }))

    assertTruthy(jobId)
    const job = await spy.waitForJobWithId(jobId, 'completed')

    expect(job.state).toBe('completed')
    expect((job.output as { something: string }).something).toBe(something)
  })

  it('job can be deleted in handler', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, async ([job]) => ctx.boss!.deleteJob(ctx.schema, job.id))

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'completed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should allow multiple workers to the same ctx.schema per instance', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.work(ctx.schema, async () => {})
    await ctx.boss.work(ctx.schema, async () => {})
  })

  it('should honor the includeMetadata option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    return new Promise<void>((resolve) => {
      ctx.boss!.work(ctx.schema, { includeMetadata: true }, async ([job]) => {
        expect(job.startedOn).toBeDefined()
        resolve()
      })
    })
  })

  it('should fail job at expiration in worker', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await ctx.boss.work(ctx.schema, () => delay(2000))

    await delay(2000)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as any).message).toContain('handler execution exceeded')
  })

  it('should fail a batch of jobs at expiration in worker', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })

    const jobId1 = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })
    const jobId2 = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await ctx.boss.work(ctx.schema, { batchSize: 2 }, () => delay(2000))

    await delay(2000)

    assertTruthy(jobId1)
    assertTruthy(jobId2)
    const job1 = await ctx.boss.getJobById(ctx.schema, jobId1)
    const job2 = await ctx.boss.getJobById(ctx.schema, jobId2)

    assertTruthy(job1)
    expect(job1.state).toBe('failed')
    expect((job1.output as any).message).toContain('handler execution exceeded')

    assertTruthy(job2)
    expect(job2.state).toBe('failed')
    expect((job2.output as any).message).toContain('handler execution exceeded')
  })
})
