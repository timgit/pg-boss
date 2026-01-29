import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('delete', function () {
  it('should delete a completed job via maintenance', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1
    }

    ctx.boss = await helper.start(config)

    const jobId = await ctx.boss.send(ctx.schema, null, { deleteAfterSeconds: 1 })

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(1000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should delete a completed job via maintenance - cascade config from queue', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.createQueue(ctx.schema, { deleteAfterSeconds: 1 })

    const jobId = await ctx.boss.send(ctx.schema)
    expect(jobId).toBeTruthy()
    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(1000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should delete a job via deleteJob()', async function () {
    const config = { ...ctx.bossConfig }
    ctx.boss = await helper.start(config)

    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)

    assertTruthy(jobId)
    await ctx.boss.deleteJob(ctx.schema, jobId)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should never delete a completed job when deleteAfterSeconds is 0', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1
    }

    ctx.boss = await helper.start(config)

    const jobId = await ctx.boss.send(ctx.schema, null, { deleteAfterSeconds: 0 })

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(2000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeTruthy()
    expect(job?.state).toBe('completed')
  })

  it('should never delete a completed job when deleteAfterSeconds is 0 - cascade config from queue', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.createQueue(ctx.schema, { deleteAfterSeconds: 0 })

    const jobId = await ctx.boss.send(ctx.schema)
    expect(jobId).toBeTruthy()
    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(2000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeTruthy()
    expect(job?.state).toBe('completed')
  })
})
