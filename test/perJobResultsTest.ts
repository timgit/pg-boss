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

  it('settles a large batch of distinct per-job outputs', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const size = 25
    const ids: string[] = []
    for (let i = 0; i < size; i++) {
      const id = await ctx.boss.send(ctx.schema, { n: i }, { retryLimit: 0 })
      assertTruthy(id)
      ids.push(id)
    }

    // Even indices complete with a distinct output, odd indices fail with a distinct output.
    await ctx.boss.work(ctx.schema, { batchSize: size, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => {
        const n = (job.data as { n: number }).n
        return n % 2 === 0
          ? { id: job.id, status: 'completed' as const, output: { n } }
          : { id: job.id, status: 'failed' as const, output: new Error(`failed ${n}`) }
      }))

    for (let i = 0; i < size; i++) {
      await spy.waitForJobWithId(ids[i]!, i % 2 === 0 ? 'completed' : 'failed')
      const job = await ctx.boss.getJobById(ctx.schema, ids[i]!)
      assertTruthy(job)
      if (i % 2 === 0) {
        expect(job.state).toBe('completed')
        expect((job.output as { n: number }).n).toBe(i)
      } else {
        expect(job.state).toBe('failed')
        expect((job.output as { message: string }).message).toBe(`failed ${i}`)
      }
    }
  })

  it('fails jobs the handler omits from its results', async function () {
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

  it('retries a per-job failure and can settle it on a later attempt', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'flaky' }, { retryLimit: 1, retryDelay: 0 })
    assertTruthy(jobId)

    // Fail the job on its first processing, complete it on the retry. This exercises the
    // fail -> reinsert-as-retry -> re-fetch -> settle path that retryLimit: 0 tests never reach.
    let attempts = 0
    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => {
        attempts++
        return attempts === 1
          ? { id: job.id, status: 'failed' as const, output: new Error('transient') }
          : { id: job.id, status: 'completed' as const, output: { ok: true } }
      }))

    await spy.waitForJobWithId(jobId, 'failed')
    await spy.waitForJobWithId(jobId, 'completed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('completed')
    expect(job.retryCount).toBe(1)
    expect((job.output as { ok: boolean }).ok).toBe(true)
  })

  it('routes a per-job failure to the dead letter queue with its own output', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => ({ id: job.id, status: 'failed' as const, output: new Error('dlq please') })))

    await spy.waitForJobWithId(jobId, 'failed')

    // The dead letter job carries the original data and the per-job failure output.
    const [dlqJob] = await ctx.boss.fetch<{ key: string }>(deadLetter)
    assertTruthy(dlqJob)
    expect(dlqJob.data.key).toBe('payload')

    const dlqWithMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
    assertTruthy(dlqWithMeta)
    expect((dlqWithMeta.output as { message: string }).message).toBe('dlq please')
  })

  it('unblocks a dependent child when the blocking parent is completed via perJobResults', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema, data: { role: 'parent' } },
      { ref: 'child', name: ctx.schema, data: { role: 'child' }, dependsOn: ['parent'] }
    ])
    const parentId = flow.parent
    const childId = flow.child

    const parentBefore = await ctx.boss.getJobById(ctx.schema, parentId)
    assertTruthy(parentBefore)
    expect(parentBefore.blocking).toBe(true)

    // The worker only ever fetches the parent until it completes; completing it through the
    // perJobResults path must run the dependency-unblock CTE so the child becomes fetchable.
    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => ({ id: job.id, status: 'completed' as const, output: { role: (job.data as { role: string }).role } })))

    await spy.waitForJobWithId(parentId, 'completed')
    await spy.waitForJobWithId(childId, 'completed')

    const child = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(child)
    expect(child.blocked).toBe(false)
    expect(child.pendingDependencies).toBe(0)
    expect(child.state).toBe('completed')
  })

  it('fails a job whose result carries an unrecognized status', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      // @ts-expect-error 'skipped' is not a valid JobResultStatus
      jobs.map(job => ({ id: job.id, status: 'skipped', output: { ignored: true } })))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as { message: string }).message).toBe('no disposition returned by handler')
  })
})
