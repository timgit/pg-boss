import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('monitoring', function () {
  it('should cache job counts into queue', async function () {
    const config = {
      ...ctx.bossConfig,
      monitorIntervalSeconds: 1
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.fetch(ctx.schema)

    await delay(1000)
    await ctx.boss.supervise()
    const result1 = await ctx.boss.getQueue(ctx.schema)

    expect(result1).toBeTruthy()

    expect(result1!.queuedCount).toBe(2)
    expect(result1!.activeCount).toBe(1)
    expect(result1!.totalCount).toBe(3)

    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    await delay(1000)
    await ctx.boss.supervise(ctx.schema)
    const result2 = await ctx.boss.getQueue(ctx.schema)

    expect(result2).toBeTruthy()

    expect(result2!.queuedCount).toBe(1)
    expect(result2!.activeCount).toBe(1)
    expect(result2!.totalCount).toBe(3)
  })

  it('queue cache should emit error', async function () {
    const config = {
      ...ctx.bossConfig,
      queueCacheIntervalSeconds: 1,
      __test__throw_queueCache: true
    }

    let errorCount = 0

    ctx.boss = await helper.start(config)

    ctx.boss.on('error', () => errorCount++)

    await delay(2000)

    expect(errorCount > 0).toBeTruthy()
  })

  it('slow maintenance should emit warning', async function () {
    const config = {
      ...ctx.bossConfig,
      __test__warn_slow_query: true,
      warningSlowQuerySeconds: 1
    }

    ctx.boss = await helper.start(config)

    let eventCount = 0
    ctx.boss.on('warning', (event) => {
      expect(event.message.includes('slow')).toBeTruthy()
      eventCount++
    })

    await ctx.boss.supervise(ctx.schema)

    expect(eventCount > 0).toBeTruthy()
  })

  it('large queue should emit warning using global default', async function () {
    const config = {
      ...ctx.bossConfig,
      monitorIntervalSeconds: 1,
      warningQueueSize: 1
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    let eventCount = 0

    ctx.boss.on('warning', (event) => {
      expect(event.message.includes('queue')).toBeTruthy()
      eventCount++
    })

    await ctx.boss.supervise(ctx.schema)

    await delay(1000)

    expect(eventCount > 0).toBeTruthy()
  })

  it('large queue should emit warning via queue config', async function () {
    const config = {
      ...ctx.bossConfig,
      monitorIntervalSeconds: 1,
      noDefault: true
    }

    ctx.boss = await helper.start(config)
    await ctx.boss.createQueue(ctx.schema, { warningQueueSize: 1 })

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    let eventCount = 0

    ctx.boss.on('warning', (event) => {
      expect(event.message.includes('queue')).toBeTruthy()
      eventCount++
    })

    await ctx.boss.supervise(ctx.schema)

    await delay(1000)

    expect(eventCount > 0).toBeTruthy()
  })

  it('should reset cached counts to zero when all jobs are deleted for given queue', async function () {
    const config = {
      ...ctx.bossConfig,
      monitorIntervalSeconds: 1
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    await ctx.boss.supervise()

    await ctx.boss.deleteAllJobs(ctx.schema)

    await delay(1000)
    await ctx.boss.supervise()
    const result = await ctx.boss.getQueue(ctx.schema)
    expect(result).toBeTruthy()

    expect(result!.queuedCount).toBe(0)
    expect(result!.activeCount).toBe(0)
    expect(result!.deferredCount).toBe(0)
    expect(result!.totalCount).toBe(0)
  })
})
