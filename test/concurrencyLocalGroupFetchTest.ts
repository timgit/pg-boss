import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('localGroupConcurrency (fetch & capacity)', function () {
  it('should handle mixed grouped and ungrouped jobs with localGroupConcurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'test-group'
    const localGroupConcurrency = 1
    const processedJobs: string[] = []

    // Send grouped jobs
    for (let i = 0; i < 2; i++) {
      await ctx.boss.send(ctx.schema, { type: 'grouped', index: i }, {
        group: { id: groupId }
      })
    }

    // Send ungrouped jobs
    for (let i = 0; i < 2; i++) {
      await ctx.boss.send(ctx.schema, { type: 'ungrouped', index: i })
    }

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 4,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5
    }, async (jobs) => {
      const job = jobs[0]
      const type = (job.data as { type: string }).type
      processedJobs.push(type)
      await delay(100)
    })

    await delay(3000)

    // All 4 jobs should be processed
    expect(processedJobs.length).toBe(4)
    expect(processedJobs.filter(t => t === 'grouped').length).toBe(2)
    expect(processedJobs.filter(t => t === 'ungrouped').length).toBe(2)
  })

  it('should process grouped jobs without localGroupConcurrency bypassing local tracking', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'test-group'
    let processedCount = 0

    // Send jobs with group (but no localGroupConcurrency configured)
    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { index: i }, {
        group: { id: groupId }
      })
    }

    // Work without localGroupConcurrency - should process normally without local tracking
    await ctx.boss.work(ctx.schema, {
      localConcurrency: 2,
      pollingIntervalSeconds: 0.5
    }, async () => {
      processedCount++
      await delay(100)
    })

    await delay(2000)

    // All jobs should be processed
    expect(processedCount).toBe(3)
  })

  it('should cleanup local group tracking when offWork is called', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'cleanup-test-group'
    const localGroupConcurrency = 2

    // Send and process some grouped jobs
    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { index: i }, {
        group: { id: groupId }
      })
    }

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 2,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5
    }, async () => {
      await delay(100)
    })

    await delay(2000)

    // Stop the worker - this should trigger cleanup
    await ctx.boss.offWork(ctx.schema)

    // Start a new worker - should work without issues (proves cleanup happened)
    let newProcessedCount = 0
    await ctx.boss.send(ctx.schema, { newJob: true }, { group: { id: groupId } })

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 2,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5
    }, async () => {
      newProcessedCount++
      await delay(100)
    })

    await delay(1500)

    // New job should be processed, confirming fresh state
    expect(newProcessedCount).toBe(1)
  })

  it('should exclude groups at local capacity from fetch', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'capacity-test-group'
    const localGroupConcurrency = 1
    const localConcurrency = 4

    let maxConcurrentForGroup = 0
    let currentConcurrentForGroup = 0
    let totalProcessed = 0

    // Send many jobs for the same group
    for (let i = 0; i < 6; i++) {
      await ctx.boss.send(ctx.schema, { index: i }, {
        group: { id: groupId }
      })
    }

    // Use multiple workers with localGroupConcurrency to trigger capacity check
    // The pollingInterval is fast so fetches happen while jobs are processing
    await ctx.boss.work(ctx.schema, {
      localConcurrency,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5 // Min allowed polling interval
    }, async () => {
      currentConcurrentForGroup++
      maxConcurrentForGroup = Math.max(maxConcurrentForGroup, currentConcurrentForGroup)

      await delay(800) // Hold the job to ensure capacity tracking kicks in
      currentConcurrentForGroup--
      totalProcessed++
    })

    await delay(8000)

    // Should respect localGroupConcurrency limit
    expect(maxConcurrentForGroup).toBeLessThanOrEqual(localGroupConcurrency)
    // All jobs should eventually be processed
    expect(totalProcessed).toBe(6)
  })
})
