import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('delayed jobs', function () {
  it('should wait until after an int (in seconds)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const startAfter = 2

    await ctx.boss.send(ctx.schema, null, { startAfter })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(startAfter * 1000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should wait until after a date time string', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const date = new Date()

    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date.toISOString()

    await ctx.boss.send(ctx.schema, null, { startAfter })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(5000)

    const job2 = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should wait until after a date object', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await ctx.boss.send(ctx.schema, null, { startAfter })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(2000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should work with sendAfter() and a date object', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await ctx.boss.sendAfter(ctx.schema, { something: 1 }, { retryLimit: 0 }, startAfter)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(2000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })
})
