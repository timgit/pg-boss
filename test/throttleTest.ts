import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('throttle', function () {
  it('should only create 1 job for interval', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const singletonSeconds = 2
    const sendCount = 4

    for (let i = 0; i < sendCount; i++) {
      await ctx.boss.send(ctx.schema, null, { singletonSeconds })
      await delay(1000)
    }

    const { length } = await ctx.boss.fetch(ctx.schema, { batchSize: sendCount })

    expect(length < sendCount).toBeTruthy()
  })

  it('should process at most 1 job per second', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const singletonSeconds = 1
    const jobCount = 3
    const sendInterval = 100
    const assertTimeout = jobCount * 1000

    const sendCount = 0
    let processCount = 0

    ctx.boss.work(ctx.schema, async () => processCount++)

    for (let i = 0; i < sendCount; i++) {
      await ctx.boss.send(ctx.schema, null, { singletonSeconds })
      await delay(sendInterval)
    }

    await delay(assertTimeout)

    expect(processCount <= jobCount + 1).toBeTruthy()
  })

  it('should debounce', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, null, { singletonSeconds: 300 })

    expect(jobId).toBeTruthy()

    const jobId2 = await ctx.boss.send(ctx.schema, null, { singletonSeconds: 300, singletonNextSlot: true })

    expect(jobId2).toBeTruthy()
  })

  it('should debounce via sendDebounced()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const seconds = 60

    const jobId = await ctx.boss.sendDebounced(ctx.schema, null, null, seconds)

    expect(jobId).toBeTruthy()

    const jobId2 = await ctx.boss.sendDebounced(ctx.schema, null, null, seconds)

    expect(jobId2).toBeTruthy()

    const jobId3 = await ctx.boss.sendDebounced(ctx.schema, null, null, seconds)

    expect(jobId3).toBe(null)
  })

  it('should reject 2nd request in the same time slot', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId1 = await ctx.boss.send(ctx.schema, null, { singletonSeconds: 300 })

    expect(jobId1).toBeTruthy()

    const jobId2 = await ctx.boss.send(ctx.schema, null, { singletonSeconds: 300 })

    expect(jobId2).toBe(null)
  })

  it('should throttle via sendThrottled()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const seconds = 60

    const jobId1 = await ctx.boss.sendThrottled(ctx.schema, null, null, seconds)

    expect(jobId1).toBeTruthy()

    const jobId2 = await ctx.boss.sendThrottled(ctx.schema, null, null, seconds)

    expect(jobId2).toBe(null)
  })

  it('should not allow more than 1 complete job with the same key with an interval', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const singletonKey = 'a'
    const singletonSeconds = 60

    await ctx.boss.send(ctx.schema, null, { singletonKey, singletonSeconds })
    const [job] = await ctx.boss.fetch(ctx.schema)

    await ctx.boss.complete(ctx.schema, job.id)

    const jobId = await ctx.boss.send(ctx.schema, null, { singletonKey, singletonSeconds })

    expect(jobId).toBe(null)
  })
})
