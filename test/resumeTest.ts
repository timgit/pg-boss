import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
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

  it('should cancel and resume a pending job with custom connection', async function () {
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
