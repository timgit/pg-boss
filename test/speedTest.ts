import { expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('speed', function () {
  const jobCount = 5_000
  const queue = 'speedTest'
  const data = new Array(jobCount).fill(null).map((item, index) => ({ name: queue, data: { index } }))

  it(`should be able to fetch and complete ${jobCount} jobs in 9 seconds`, { timeout: 9000 }, async function () {
    const config = { ...ctx.bossConfig, min: 10, max: 10, noDefault: true }
    ctx.boss = await helper.start(config)
    await ctx.boss.createQueue(queue)
    await ctx.boss.insert(queue, data)
    const jobs = await ctx.boss.fetch(queue, { batchSize: jobCount })

    expect(jobs.length).toBe(jobCount)

    await ctx.boss.complete(queue, jobs.map(job => job.id))
  })
})
