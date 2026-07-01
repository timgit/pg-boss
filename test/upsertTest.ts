import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'

const SOME_UUID = '00000000-0000-0000-0000-000000000000'

describe('upsert', function () {
  it('should reject when no singletonKey is provided', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(ctx.boss.upsert(ctx.schema, { v: 1 })).rejects.toThrow(/requires a singletonKey/)
  })

  it('should reject when targeting by id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(ctx.boss.upsert(ctx.schema, { v: 1 }, { id: SOME_UUID, singletonKey: 'k' })).rejects.toThrow(/cannot accept an id/)
  })

  it('should insert a new job when none exists for the key', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const result = await ctx.boss.upsert(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.jobs).toHaveLength(1)

    const job = await ctx.boss.getJobById(ctx.schema, result.jobs[0])
    assertTruthy(job)
    expect(job.data).toEqual({ v: 1 })
    expect(job.singletonKey).toBe('k')
  })

  it('should update the existing pre-active job in place, preserving its id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    assertTruthy(id)

    const result = await ctx.boss.upsert(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })
  })

  it('should insert a fresh job when the existing one is already active', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    assertTruthy(id)

    const [fetched] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(fetched)

    const result = await ctx.boss.upsert(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).not.toBe(id)

    const job = await ctx.boss.getJobById(ctx.schema, result.jobs[0])
    assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })

    // the originally active job is untouched
    const original = await ctx.boss.getJobById(ctx.schema, id)
    expect(original!.state).toBe('active')
    expect(original!.data).toEqual({ v: 1 })
  })
})
