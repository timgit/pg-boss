import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'
import { PgBoss } from '../src/index.ts'

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

  it('should not leak warningQueueSize to other instances', async function () {
    // eslint-disable-next-line no-new
    new PgBoss({ ...ctx.bossConfig, warningQueueSize: 1 })

    const boss = ctx.boss = await helper.start(ctx.bossConfig)
    await boss.send(ctx.schema)
    await boss.send(ctx.schema)

    let leaked = false
    boss.on('warning', (event) => { if (event.message.includes('queue')) leaked = true })

    await boss.supervise(ctx.schema)

    expect(leaked).toBe(false)
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

  it('deferred jobs over threshold should emit backlog warning', async function () {
    const config = {
      ...ctx.bossConfig,
      monitorIntervalSeconds: 1,
      warningQueueSize: 1
    }

    ctx.boss = await helper.start(config)

    // Both jobs are deferred (future-dated). The warning is based on queuedCount (which
    // includes deferred jobs), so dumping a lot of deferred work still trips the warning.
    await ctx.boss.send(ctx.schema, {}, { startAfter: 100 })
    await ctx.boss.send(ctx.schema, {}, { startAfter: 100 })

    let backlogWarnings = 0

    ctx.boss.on('warning', (event) => {
      if (event.message.includes('backlog')) backlogWarnings++
    })

    await ctx.boss.supervise(ctx.schema)

    await delay(1000)

    expect(backlogWarnings > 0).toBeTruthy()
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

  it('slow maintenance should emit a warning event', async function () {
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
})
