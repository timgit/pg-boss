import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('priority', function () {
  it('higher priority job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const high = await ctx.boss.send(ctx.schema, null, { priority: 1 })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.id).toBe(high)
  })

  it('descending priority order', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const low = await ctx.boss.send(ctx.schema, null, { priority: 1 })
    const medium = await ctx.boss.send(ctx.schema, null, { priority: 5 })
    const high = await ctx.boss.send(ctx.schema, null, { priority: 10 })

    const [job1] = await ctx.boss.fetch(ctx.schema)
    const [job2] = await ctx.boss.fetch(ctx.schema)
    const [job3] = await ctx.boss.fetch(ctx.schema)

    expect(job1.id).toBe(high)
    expect(job2.id).toBe(medium)
    expect(job3.id).toBe(low)
  })

  it('bypasses priority when priority option used in fetch', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const low = await ctx.boss.send(ctx.schema, null, { priority: 1 })
    const medium = await ctx.boss.send(ctx.schema, null, { priority: 5 })
    const high = await ctx.boss.send(ctx.schema, null, { priority: 10 })

    const [job1] = await ctx.boss.fetch(ctx.schema, { priority: false })
    const [job2] = await ctx.boss.fetch(ctx.schema, { priority: false })
    const [job3] = await ctx.boss.fetch(ctx.schema, { priority: false })

    expect(job1.id).toBe(low)
    expect(job2.id).toBe(medium)
    expect(job3.id).toBe(high)
  })
})
