import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('expire', function () {
  it('should expire a job', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    expect(jobId).toBeTruthy()

    const [job1] = await ctx.boss.fetch(ctx.schema)

    expect(job1).toBeTruthy()

    await delay(1000)

    await ctx.boss.supervise(ctx.schema)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('failed')
  })

  it('should expire a job - cascaded config', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    // fetch the job but don't complete it
    await ctx.boss.fetch(ctx.schema)

    await delay(1000)

    await ctx.boss.supervise(ctx.schema)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('failed')
  })

  it('should expire a job via supervise option', async function () {
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noDefault: true,
      supervise: true,
      monitorIntervalSeconds: 1,
      superviseIntervalSeconds: 1
    })

    await ctx.boss.createQueue(ctx.schema, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    // fetch the job but don't complete it
    await ctx.boss.fetch(ctx.schema)

    await delay(4000)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('failed')
  })

  it('should abort signal when job handler times out', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    expect(jobId).toBeTruthy()

    let signalAborted = false

    await ctx.boss.work(ctx.schema, async ([job]) => {
      job.signal.addEventListener('abort', () => {
        signalAborted = true
      })
      await delay(2000)
    })

    await delay(3000)

    expect(signalAborted).toBe(true)
  })
})
