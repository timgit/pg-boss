import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { TestClock } from '../src/index.ts'
import { ctx } from './hooks.ts'

describe('cancel', function () {
  it('should reject missing id argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.resume()
    }).rejects.toThrow()
  })

  it('should cancel and resume a pending job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, null, { startAfter: 1 })

    expect(jobId).toBeTruthy()

    assertTruthy(jobId)
    await ctx.boss.cancel(ctx.schema, jobId)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job && job.state === 'cancelled').toBeTruthy()

    await ctx.boss.resume(ctx.schema, jobId)

    const job2 = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job2 && job2.state === 'created').toBeTruthy()
  })

  it('should move startAfter up to the resume, keeping one still ahead', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    const pastId = await ctx.boss.send(ctx.schema)
    const futureId = await ctx.boss.send(ctx.schema, null, { startAfter: 7200 })
    assertTruthy(pastId)
    assertTruthy(futureId)
    const future = await ctx.boss.getJobById(ctx.schema, futureId)
    assertTruthy(future)

    await ctx.boss.cancel(ctx.schema, [pastId, futureId])
    await clock.tick(60_000)
    await ctx.boss.resume(ctx.schema, [pastId, futureId])

    const past = await ctx.boss.getJobById(ctx.schema, pastId)
    assertTruthy(past)
    expect(past.startAfter.getTime()).toBe(clock.now())

    const stillAhead = await ctx.boss.getJobById(ctx.schema, futureId)
    assertTruthy(stillAhead)
    expect(stillAhead.startAfter.getTime()).toBe(future.startAfter.getTime())
  })

  helper.itPglite('should cancel and resume a pending job with custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, null, { startAfter: 1 })

    expect(jobId).toBeTruthy()

    let callCount = 0
    const _db = await helper.getDb()
    const db = {
      // @ts-ignore
      async executeSql (sql, values) {
        callCount++
        // @ts-ignore
        return _db.pool.query(sql, values)
      }
    }

    assertTruthy(jobId)
    await ctx.boss.cancel(ctx.schema, jobId, { db })

    const job = await ctx.boss.getJobById(ctx.schema, jobId, { db })

    expect(job && job.state === 'cancelled').toBeTruthy()

    await ctx.boss.resume(ctx.schema, jobId, { db })

    const job2 = await ctx.boss.getJobById(ctx.schema, jobId, { db })

    expect(job2 && job2.state === 'created').toBeTruthy()
    expect(callCount).toBe(4)
  })
})
