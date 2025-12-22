import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('cancel', function () {
  it('should reject missing arguments', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.cancel()
    }).rejects.toThrow()
  })

  it('should cancel a pending job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, {}, { startAfter: 1 })

    assertTruthy(jobId)
    await ctx.boss.cancel(ctx.schema, jobId)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job && job.state === 'cancelled').toBeTruthy()
  })

  it('should not cancel a completed job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    const completeResult = await ctx.boss.complete(ctx.schema, job.id)

    expect(completeResult.affected).toBe(1)

    const cancelResult = await ctx.boss.cancel(ctx.schema, job.id)

    expect(cancelResult.affected).toBe(0)
  })

  it('should cancel a batch of jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobs = await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    await ctx.boss.cancel(ctx.schema, jobs as string[])
  })

  it('should cancel a pending job with custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return (_db as any).pool.query(sql, values)
      }
    }

    const jobId = await ctx.boss.send(ctx.schema, {}, { startAfter: 1 })

    assertTruthy(jobId)
    await ctx.boss.cancel(ctx.schema, jobId, { db })

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job && job.state === 'cancelled').toBeTruthy()
    expect(called).toBe(true)
  })
})
