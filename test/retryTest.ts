import { expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { TestClock } from '../src/index.ts'
import { ctx } from './hooks.ts'
import type { JobWithMetadata } from '../src/types.ts'

describe('retries', function () {
  it('should retry a job that didn\'t complete', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    const jobId = await ctx.boss.send({ name: ctx.schema, options: { expireInSeconds: 1, retryLimit: 1 } })

    const [try1] = await ctx.boss.fetch(ctx.schema)

    await clock.tick(1001)
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
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 1 })

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId)

    const [job1] = await ctx.boss.fetch(ctx.schema)

    expect(job1).toBeFalsy()

    await clock.tick(1000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should retry with a exponential backoff', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    const retryDelay = 2

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 4, retryDelay, retryBackoff: true })
    assertTruthy(jobId)

    // Each failure pushes start_after out by retryDelay * (2^n / 2) * (1 + jitter), so the floor of
    // every backoff doubles: [2, 4), then [4, 8), then [8, 16) seconds.
    for (const attempt of [1, 2, 3]) {
      const [job] = await ctx.boss.fetch(ctx.schema)
      expect(job?.id).toBe(jobId)

      const failedAt = clock.now()
      await ctx.boss.fail(ctx.schema, jobId)

      const retried: JobWithMetadata | null = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(retried)
      const backoffSeconds = (new Date(retried.startAfter).getTime() - failedAt) / 1000
      const floor = retryDelay * Math.pow(2, attempt) / 2

      expect(backoffSeconds).toBeGreaterThanOrEqual(floor)
      expect(backoffSeconds).toBeLessThan(floor * 2)

      expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)
      await clock.tick(floor * 2 * 1000)
    }
  })

  it('should apply nonzero backoff when retryBackoff is set but retryDelay is not (#839)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // retryBackoff enabled, retryDelay left unset (defaults to 0). Before the fix the
    // backoff formula multiplied by 0, so the retry fired immediately.
    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 1, retryBackoff: true })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)

    const t0 = Date.now()
    await ctx.boss.fail(ctx.schema, jobId)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    assertTruthy(job.startAfter)

    const backoffSeconds = (new Date(job.startAfter).getTime() - t0) / 1000
    // First retry with retry_delay floored to 1 lands ~1-2s out; assert it is clearly nonzero.
    expect(backoffSeconds).toBeGreaterThan(0.5)

    // job should not be immediately fetchable
    const [immediate] = await ctx.boss.fetch(ctx.schema)
    expect(immediate).toBeFalsy()
  })

  it('should limit retry delay with exponential backoff', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    const retryLimit = 4
    const retryDelayMax = 3

    const jobId = await ctx.boss.send(ctx.schema, null, {
      retryLimit,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax
    })
    assertTruthy(jobId)

    // Uncapped, the third and fourth backoffs would exceed the cap; every one must stay under it.
    for (let attempt = 0; attempt < retryLimit; attempt++) {
      const [job] = await ctx.boss.fetch(ctx.schema)
      expect(job?.id).toBe(jobId)

      const failedAt = clock.now()
      await ctx.boss.fail(ctx.schema, jobId)

      const retried: JobWithMetadata | null = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(retried)
      const backoffSeconds = (new Date(retried.startAfter).getTime() - failedAt) / 1000

      expect(backoffSeconds).toBeGreaterThan(0)
      expect(backoffSeconds).toBeLessThanOrEqual(retryDelayMax)

      await clock.tick(retryDelayMax * 1000)
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

  it('manual retry clears completed_on so retention deletion is not mis-triggered', async function () {
    // fail() stamps completed_on; retry() must null it again (like resume does). If it lingers, a
    // queue with deleteAfterSeconds can delete the job while it sits queued or active mid-flight.
    ctx.boss = await helper.start(ctx.bossConfig)
    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })
    assertTruthy(jobId)
    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId)

    const failed = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(failed.rows[0].completed_on).toBeTruthy()

    await ctx.boss.retry(ctx.schema, jobId)

    const retried = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(retried.rows[0].state).toBe('retry')
    expect(retried.rows[0].completed_on).toBeNull()
  })
})
