import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('work', function () {
  it('should fail with no arguments', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.work()
    }).rejects.toThrow()
  })

  it('should fail if no callback provided', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.work('foo')
    }).rejects.toThrow()
  })

  it('should fail if options is not an object', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.work('foo', async () => {}, 'nope')
    }).rejects.toThrow()
  })

  it('offWork should fail without a name', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.offWork()
    }).rejects.toThrow()
  })

  it('should honor a custom polling interval', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const pollingIntervalSeconds = 1
    const timeout = 5000
    let processCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {
      processCount++
    })

    await delay(timeout)

    expect(processCount).toBe(timeout / 1000 / pollingIntervalSeconds)
  })

  it('should provide abort signal to job handler', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    let receivedSignal = {}

    const jobId = await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, async ([job]) => {
      receivedSignal = job.signal
    })

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'completed')

    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })

  it('should honor when a worker is notified', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    let processCount = 0

    const jobId1 = await ctx.boss.send(ctx.schema)

    const workerId = await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 5 }, async () => processCount++)

    assertTruthy(jobId1)
    await spy.waitForJobWithId(jobId1, 'completed')

    expect(processCount).toBe(1)

    const jobId2 = await ctx.boss.send(ctx.schema)

    ctx.boss.notifyWorker(workerId)

    assertTruthy(jobId2)
    await spy.waitForJobWithId(jobId2, 'completed')

    expect(processCount).toBe(2)
  })

  it('should remove a worker', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let receivedCount = 0

    ctx.boss.work(ctx.schema, async () => {
      receivedCount++
      await ctx.boss!.offWork(ctx.schema)
    })

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    await delay(5000)

    expect(receivedCount).toBe(1)
  })

  it('should remove a worker by id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let receivedCount = 0

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    const id = await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      receivedCount++
      await ctx.boss!.offWork(ctx.schema, { id })
    })

    await delay(2000)

    expect(receivedCount).toBe(1)
  })

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

  it('should emit wip event every 2s for workers', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const firstWipEvent = new Promise<Array<any>>(resolve => ctx.boss!.once('wip', resolve))

    await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 1 }, () => delay(2000))

    const wip1 = await firstWipEvent

    await ctx.boss.send(ctx.schema)

    expect(wip1.length).toBe(1)

    const secondWipEvent = new Promise<Array<any>>(resolve => ctx.boss!.once('wip', resolve))

    const wip2 = await secondWipEvent

    expect(wip2.length).toBe(1)
  })

  it('should reject work() after stopping', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.stop()

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, async () => {})
    }).rejects.toThrow()
  })

  it('should allow send() after stopping', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    ctx.boss.stop({ close: false })

    await ctx.boss.send(ctx.schema)
  })
})
