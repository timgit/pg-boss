import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('perJobResults', function () {
  it('validates perJobResults must be a boolean', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-expect-error invalid option type
      await ctx.boss.work(ctx.schema, { perJobResults: 'yes' }, async () => [])
    }).rejects.toThrow('perJobResults must be a boolean')
  })

  it('settles each job in a batch individually with its own output', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const completeId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    const failId = await ctx.boss.send(ctx.schema, { outcome: 'fail' }, { retryLimit: 0 })
    assertTruthy(completeId)
    assertTruthy(failId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => (job.data as { outcome: string }).outcome === 'complete'
        ? { id: job.id, status: 'completed', output: { ok: true } }
        : { id: job.id, status: 'failed', output: new Error('handler said fail') }))

    await spy.waitForJobWithId(completeId, 'completed')
    await spy.waitForJobWithId(failId, 'failed')

    const completed = await ctx.boss.getJobById(ctx.schema, completeId)
    const failed = await ctx.boss.getJobById(ctx.schema, failId)

    assertTruthy(completed)
    expect(completed.state).toBe('completed')
    expect((completed.output as { ok: boolean }).ok).toBe(true)

    assertTruthy(failed)
    expect(failed.state).toBe('failed')
    expect((failed.output as { message: string }).message).toBe('handler said fail')
  })

  it('fails (and retries) jobs the handler omits from its results', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const keptId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    const omittedId = await ctx.boss.send(ctx.schema, { outcome: 'omit' }, { retryLimit: 0 })
    assertTruthy(keptId)
    assertTruthy(omittedId)

    // Handler only reports the kept job; the omitted one is left out of the results entirely.
    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs
        .filter(job => (job.data as { outcome: string }).outcome !== 'omit')
        .map(job => ({ id: job.id, status: 'completed' as const })))

    await spy.waitForJobWithId(keptId, 'completed')
    await spy.waitForJobWithId(omittedId, 'failed')

    const kept = await ctx.boss.getJobById(ctx.schema, keptId)
    const omitted = await ctx.boss.getJobById(ctx.schema, omittedId)

    assertTruthy(kept)
    expect(kept.state).toBe('completed')

    assertTruthy(omitted)
    expect(omitted.state).toBe('failed')
    expect((omitted.output as { message: string }).message).toBe('no disposition returned by handler')
  })

  it('fails the whole batch when the handler does not resolve with an array', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 },
      // @ts-expect-error deliberately violating the contract
      async () => ({ not: 'an array' }))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as { message: string }).message).toContain('must resolve with an array')
  })

  it('still fails the whole batch when the handler throws', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error('boom')
    })

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as { message: string }).message).toBe('boom')
  })
})
