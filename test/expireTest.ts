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

  it('should expire a job through the standard (non-distributed) path', async function () {
    // Pin the standard maintenance path even under DISTRIBUTED=true. getConfig() force-enables
    // __test__distributed for the distributed CI run, which routes expiry through
    // failJobsByTimeoutDistributed; overriding it back to false exercises boss.ts's standard
    // failJobsByTimeout branch + plans.failJobsByTimeout here, so neither CI flag leaves the
    // other branch uncovered (mirror of distributedDatabaseTest pinning __test__distributed:true).
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: false })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)

    // Backdate started_on past the expiration window instead of sleeping — deterministic and fast.
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${ctx.schema}.job SET started_on = now() - interval '1 hour' WHERE id = $1`, [jobId])
    await db.close()

    await ctx.boss.supervise(ctx.schema)

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
