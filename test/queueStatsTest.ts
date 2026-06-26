import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import type { ConstructorOptions } from '../src/types.ts'
import { ctx } from './hooks.ts'

describe('queueStats', function () {
  const queue1 = `q${randomUUID().replaceAll('-', '')}`
  const queue2 = `q${randomUUID().replaceAll('-', '')}`

  async function init (config: (ConstructorOptions & { schema: string }) | (Partial<ConstructorOptions> & { testKey?: string; noDefault?: boolean }) | undefined) {
    const boss = await helper.start(config)

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    await boss.send(queue1)
    await boss.send(queue1)
    await boss.send(queue2)
    await boss.send(queue2)

    return boss
  }

  it('should get accurate stats', async function () {
    ctx.boss = await init(ctx.bossConfig)
    const [queueData] = await ctx.boss.getQueueStats(queue1)
    expect(queueData).not.toBe(undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      readyCount,
      activeCount,
      failedCount,
      totalCount
    } = queueData

    expect(name).toBe(queue1)
    expect(deferredCount).toBe(0)
    expect(queuedCount).toBe(2)
    expect(readyCount).toBe(2)
    expect(activeCount).toBe(0)
    expect(failedCount).toBe(0)
    expect(totalCount).toBe(2)
  })

  it('should exclude deferred jobs from readyCount', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = randomUUID()
    await ctx.boss.createQueue(queue)

    await ctx.boss.send(queue)
    await ctx.boss.send(queue, {}, { startAfter: 100 })

    const [queueData] = await ctx.boss.getQueueStats(queue)

    expect(queueData.queuedCount).toBe(2)
    expect(queueData.deferredCount).toBe(1)
    // readyCount is the true backlog: queued minus the deferred (future-dated) job
    expect(queueData.readyCount).toBe(1)
  })

  it('should count failed jobs in failedCount', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = randomUUID()
    // retryLimit 0 so a single fail moves the job straight to the failed state
    await ctx.boss.createQueue(queue, { retryLimit: 0 })

    await ctx.boss.send(queue)
    const [job] = await ctx.boss.fetch(queue)
    await ctx.boss.fail(queue, job.id)

    const [queueData] = await ctx.boss.getQueueStats(queue)

    expect(queueData.failedCount).toBe(1)
    expect(queueData.queuedCount).toBe(0)
    expect(queueData.readyCount).toBe(0)
    expect(queueData.totalCount).toBe(1)
  })

  it('should get accurate stats on an empty queue', async function () {
    ctx.boss = await init(ctx.bossConfig)
    const queue3 = randomUUID()
    await ctx.boss.createQueue(queue3)

    const [queueData] = await ctx.boss.getQueueStats(queue3)
    expect(queueData).not.toBe(undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      activeCount,
      totalCount
    } = queueData

    expect(name).toBe(queue3)
    expect(deferredCount).toBe(0)
    expect(queuedCount).toBe(0)
    expect(activeCount).toBe(0)
    expect(totalCount).toBe(0)
  })

  it('should properly get queue stats when all jobs are deleted', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const queue4 = randomUUID()
    await ctx.boss.createQueue(queue4)

    await ctx.boss.send(queue4)
    await ctx.boss.send(queue4)
    await ctx.boss.send(queue4)

    await ctx.boss.deleteAllJobs(queue4)

    // never monitored, so getQueueStats recomputes from the job table and reflects the deletion
    const [queueData] = await ctx.boss.getQueueStats(queue4)
    expect(queueData).toBeTruthy()

    expect(queueData.deferredCount).toBe(0)
    expect(queueData.queuedCount).toBe(0)
    expect(queueData.activeCount).toBe(0)
    expect(queueData.totalCount).toBe(0)
  })
})
