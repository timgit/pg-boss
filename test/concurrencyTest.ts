import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('concurrency', function () {
  it('should spawn multiple workers when concurrency > 1', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const concurrency = 3
    const processedBy: string[] = []
    const jobCount = 6

    // Send jobs
    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    // Create worker with concurrency
    await ctx.boss.work(ctx.schema, { concurrency, pollingIntervalSeconds: 0.5 }, async () => {
      processedBy.push('worker')
      await delay(500) // Simulate some work
    })

    // Wait for jobs to complete
    await delay(5000)

    // All jobs should have been processed
    expect(processedBy.length).toBe(jobCount)
  })

  it('should process jobs in parallel with concurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const concurrency = 3
    let maxConcurrent = 0
    let currentConcurrent = 0
    const jobCount = 9

    // Send jobs
    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    // Create worker with concurrency
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

    // Send a job
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
})
