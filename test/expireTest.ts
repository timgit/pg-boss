import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { TestClock } from '../src/index.ts'
import { ctx } from './hooks.ts'

describe('expire', function () {
  it('should expire a job', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, monitorIntervalSeconds: 1 })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    expect(jobId).toBeTruthy()

    const [job1] = await ctx.boss.fetch(ctx.schema)

    expect(job1).toBeTruthy()

    // expiration is strictly after the window, so land one tick past it
    await clock.tick(1001)

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
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    // fetch the job but don't complete it
    await ctx.boss.fetch(ctx.schema)

    await clock.tick(1001)

    await ctx.boss.supervise(ctx.schema)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('failed')
  })

  it('should expire a job via supervise option', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      clock,
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

    assertTruthy(jobId)

    // Each tick fires one supervise pass; the pass itself is real I/O and reads the clock whenever
    // it reaches the database, so settle briefly after each rather than assuming which time it saw.
    const failed = async () => (await ctx.boss!.getJobById(ctx.schema, jobId))?.state === 'failed'

    for (let i = 0; i < 5 && !(await failed()); i++) {
      await clock.tick(1000)
      await helper.until(failed, 300).catch(() => {})
    }

    expect(await failed()).toBe(true)
  })

  it('should persist an expiration of exactly 24 hours', async function () {
    const expireInSeconds = 24 * 60 * 60

    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { expireInSeconds })

    const queue = await ctx.boss.getQueue(ctx.schema)

    assertTruthy(queue)
    expect(queue.expireInSeconds).toBe(expireInSeconds)

    const jobId = await ctx.boss.send(ctx.schema, null, { expireInSeconds })

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.expireInSeconds).toBe(expireInSeconds)
  })

  it('should abort signal when job handler times out', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, monitorIntervalSeconds: 1 })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    expect(jobId).toBeTruthy()

    let handlerStarted = false
    let signalAborted = false

    await ctx.boss.work(ctx.schema, ([job]) => new Promise<void>(resolve => {
      handlerStarted = true
      job.signal.addEventListener('abort', () => {
        signalAborted = true
        resolve()
      }, { once: true })
    }))

    // the expiration timer starts when the handler does, so let the fetch land before ticking
    await helper.until(() => handlerStarted)
    await clock.tick(1000)
    await helper.until(() => signalAborted)
  })
})
