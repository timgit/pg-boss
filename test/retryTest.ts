import { expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('retries', function () {
  it('should retry a job that didn\'t complete', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send({ name: ctx.schema, options: { expireInSeconds: 1, retryLimit: 1 } })

    const [try1] = await ctx.boss.fetch(ctx.schema)

    await delay(1000)
    await ctx.boss.supervise()

    const [try2] = await ctx.boss.fetch(ctx.schema)

    expect(try1.id).toBe(jobId)
    expect(try2.id).toBe(jobId)
  })

  it('should retry a job that failed', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 1 })

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.id).toBe(jobId)
  })

  it('should retry with a fixed delay', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 1 })

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId)

    const [job1] = await ctx.boss.fetch(ctx.schema)

    expect(job1).toBeFalsy()

    await delay(1000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should retry with a exponential backoff', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let processCount = 0
    const retryLimit = 4

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 1 }, async () => {
      ++processCount
      throw new Error('retry')
    })

    await ctx.boss.send(ctx.schema, null, { retryLimit, retryDelay: 2, retryBackoff: true })

    await delay(8000)

    expect(processCount < retryLimit).toBeTruthy()
  })

  it('should limit retry delay with exponential backoff', { timeout: 15000 }, async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const startAfters: Date[] = []
    const retryDelayMax = 3

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
      startAfters.push(job.startAfter)
      throw new Error('retry')
    })

    await ctx.boss.send(ctx.schema, null, {
      retryLimit: 4,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax
    })

    await delay(13000)

    const delays = startAfters.map((startAfter, index) =>
      index === 0 ? 0 : (startAfter.getTime() - startAfters[index - 1].getTime()) / 1000)

    for (const d of delays) {
      // the +1 eval here is to allow latency from the work() polling interval
      expect(d < (retryDelayMax + 1)).toBeTruthy()
    }
  })

  it('should mark a failed job to be retried', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })
    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId)
    await ctx.boss.retry(ctx.schema, jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    const { state, retryLimit } = job
    expect(state === 'retry').toBeTruthy()
    expect(retryLimit === 1).toBeTruthy()
  })
})
