import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('concurrency', function () {
  it('should spawn multiple workers when concurrency > 1', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const concurrency = 3
    const processedBy: string[] = []
    const jobCount = 6

    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    // Create worker with concurrency
    await ctx.boss.work(ctx.schema, { concurrency, pollingIntervalSeconds: 0.5 }, async () => {
      processedBy.push('worker')
      await delay(500) // Simulate some work
    })

    await delay(5000)

    expect(processedBy.length).toBe(jobCount)
  })

  it('should process jobs in parallel with concurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const concurrency = 3
    let maxConcurrent = 0
    let currentConcurrent = 0
    const jobCount = 9

    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    await ctx.boss.work(ctx.schema, { concurrency, pollingIntervalSeconds: 0.5 }, async () => {
      currentConcurrent++
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
      await delay(1000)
      currentConcurrent--
    })

    // Wait for all jobs to complete
    await delay(6000)

    // With 3 concurrent workers, we should see up to 3 jobs processed in parallel
    expect(maxConcurrent).toBeGreaterThan(1)
    expect(maxConcurrent).toBeLessThanOrEqual(concurrency)
  })

  it('should stop all workers created by concurrency option when calling offWork', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const concurrency = 3
    let processCount = 0

    // Create worker with concurrency
    await ctx.boss.work(ctx.schema, { concurrency, pollingIntervalSeconds: 0.5 }, async () => {
      processCount++
    })

    await ctx.boss.send(ctx.schema)
    await delay(1500)

    const countBefore = processCount

    // Stop all workers for this queue
    await ctx.boss.offWork(ctx.schema)

    // Send more jobs after stopping
    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await delay(1500)

    // No new jobs should have been processed
    expect(processCount).toBe(countBefore)
  })

  it('should track all jobs via spy when using concurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const concurrency = 3
    const jobCount = 6

    const jobIds: string[] = []
    for (let i = 0; i < jobCount; i++) {
      const jobId: string | null = await ctx.boss.send(ctx.schema, { index: i })
      assertTruthy(jobId)
      jobIds.push(jobId)
    }

    await ctx.boss.work(ctx.schema, { concurrency, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      await delay(200) // Simulate some work
      return { processed: true, index: (job.data as { index: number }).index }
    })

    // Wait for all jobs to complete via spy
    const completedJobs = await Promise.all(
      jobIds.map(id => spy.waitForJobWithId(id, 'completed'))
    )

    // All jobs should be tracked correctly
    expect(completedJobs.length).toBe(jobCount)
    for (const job of completedJobs) {
      expect(job.state).toBe('completed')
      expect((job.output as { processed: boolean }).processed).toBe(true)
    }
  })

  it('should track active state via spy when using concurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const concurrency = 2

    // Send jobs
    const jobId1 = await ctx.boss.send(ctx.schema, { index: 1 })
    const jobId2 = await ctx.boss.send(ctx.schema, { index: 2 })

    assertTruthy(jobId1)
    assertTruthy(jobId2)

    let resolveWorker!: () => void
    const workersStarted = new Promise<void>(resolve => { resolveWorker = resolve })
    let workersStartedCount = 0

    // Create worker with concurrency that blocks until we release it
    await ctx.boss.work(ctx.schema, { concurrency, pollingIntervalSeconds: 0.5 }, async () => {
      workersStartedCount++
      if (workersStartedCount >= 2) {
        resolveWorker()
      }
      await delay(2000) // Hold the job active for a while
    })

    // Wait for both workers to start processing
    await workersStarted

    // Both jobs should be tracked as active
    const [activeJob1, activeJob2] = await Promise.all([
      spy.waitForJobWithId(jobId1, 'active'),
      spy.waitForJobWithId(jobId2, 'active')
    ])

    expect(activeJob1.state).toBe('active')
    expect(activeJob2.state).toBe('active')
  })

  it('should track job failures via spy when using concurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const concurrency = 2

    // Send jobs that will fail
    const jobId1 = await ctx.boss.send(ctx.schema, { shouldFail: true }, { retryLimit: 0 })
    const jobId2 = await ctx.boss.send(ctx.schema, { shouldFail: true }, { retryLimit: 0 })

    assertTruthy(jobId1)
    assertTruthy(jobId2)

    // Create worker with concurrency that throws errors
    await ctx.boss.work(ctx.schema, { concurrency, pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error('intentional failure')
    })

    // Both jobs should be tracked as failed
    const [failedJob1, failedJob2] = await Promise.all([
      spy.waitForJobWithId(jobId1, 'failed'),
      spy.waitForJobWithId(jobId2, 'failed')
    ])

    expect(failedJob1.state).toBe('failed')
    expect(failedJob2.state).toBe('failed')
    expect((failedJob1.output as { message: string }).message).toBe('intentional failure')
    expect((failedJob2.output as { message: string }).message).toBe('intentional failure')
  })
})
