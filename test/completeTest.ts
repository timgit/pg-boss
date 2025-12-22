import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { states } from '../src/index.ts'
import { ctx } from './hooks.ts'

describe('complete', function () {
  it('should reject missing id argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.complete(ctx.schema)
    }).rejects.toThrow()
  })

  it('should complete a batch of jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const batchSize = 3

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const { table } = (await ctx.boss.getQueue(ctx.schema))!

    const countJobs = (state: string) => helper.countJobs(ctx.schema, table, 'name = $1 AND state = $2', [ctx.schema, state])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize })

    const activeCount = await countJobs(states.active)

    expect(activeCount).toBe(batchSize)

    const result = await ctx.boss.complete(ctx.schema, jobs.map(job => job.id))

    expect(result.jobs.length).toBe(batchSize)
  })

  it('should store job output in job.output from complete()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.id).toBe(jobId)

    const completionData = { msg: 'i am complete' }

    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId, completionData)

    const jobWithMetadata = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(jobWithMetadata).toBeTruthy()

    expect((jobWithMetadata as any).output.msg).toBe(completionData.msg)
  })

  it('should store job error in job.output from fail()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.id).toBe(jobId)

    const completionError = new Error('i am complete')

    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId, completionError)

    const jobWithMetadata = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(jobWithMetadata).toBeTruthy()

    expect((jobWithMetadata as any).output.message).toBe(completionError.message)
  })

  it('should complete a batch of jobs with custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const batchSize = 3

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const { table } = (await ctx.boss.getQueue(ctx.schema))!

    const countJobs = (state: string) => helper.countJobs(ctx.schema, table, 'name = $1 AND state = $2', [ctx.schema, state])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize })

    const activeCount = await countJobs(states.active)

    expect(activeCount).toBe(batchSize)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return (_db as any).pool.query(sql, values)
      }
    }

    const result = await ctx.boss.complete(ctx.schema, jobs.map(job => job.id), undefined, { db })

    expect(result.jobs.length).toBe(batchSize)
    expect(called).toBe(true)
  })
})
