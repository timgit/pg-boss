import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('localGroupConcurrency', function () {
  it('should limit active jobs per group with simple localGroupConcurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'tenant-123'
    const localConcurrency = 4
    const localGroupConcurrency = 2 // Must be <= localConcurrency
    const jobCount = 6

    // Track concurrent jobs per group
    let currentActive = 0
    let maxActive = 0

    // Send jobs for the same group
    for (let i = 0; i < jobCount; i++) {
      const jobId: string | null = await ctx.boss.send(ctx.schema, { index: i }, {
        group: { id: groupId }
      })
      assertTruthy(jobId)
    }

    // Create worker with localGroupConcurrency limit
    await ctx.boss.work(ctx.schema, {
      localConcurrency,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5,
      batchSize: 4 // Fetch multiple jobs at once to test limiting
    }, async (jobs) => {
      currentActive += jobs.length
      maxActive = Math.max(maxActive, currentActive)
      await delay(300)
      currentActive -= jobs.length
    })

    await delay(5000)

    // The local group concurrency limit should have been respected
    expect(maxActive).toBeLessThanOrEqual(localGroupConcurrency)
  })

  it('should allow different groups to process independently with localGroupConcurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const group1 = 'tenant-1'
    const group2 = 'tenant-2'
    const localGroupConcurrency = 1
    const localConcurrency = 4

    const activeGroups: Record<string, number> = { [group1]: 0, [group2]: 0 }
    let bothActiveAtOnce = false

    // Send jobs for both groups
    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { group: group1, index: i }, { group: { id: group1 } })
      await ctx.boss.send(ctx.schema, { group: group2, index: i }, { group: { id: group2 } })
    }

    // Create workers with localGroupConcurrency limit
    await ctx.boss.work(ctx.schema, { localConcurrency, localGroupConcurrency, pollingIntervalSeconds: 0.5 }, async (jobs) => {
      const job = jobs[0]
      const groupId = (job.data as { group: string }).group

      activeGroups[groupId]++

      // Check if both groups have active jobs simultaneously
      if (activeGroups[group1] > 0 && activeGroups[group2] > 0) {
        bothActiveAtOnce = true
      }

      // Each group should respect its own limit
      expect(activeGroups[groupId]).toBeLessThanOrEqual(localGroupConcurrency)

      await delay(300)
      activeGroups[groupId]--
    })

    await delay(5000)

    // Both groups should have been able to run jobs simultaneously
    expect(bothActiveAtOnce).toBe(true)
  })

  it('should apply tier-based limits with localGroupConcurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const enterpriseGroup = 'enterprise-tenant'
    const freeGroup = 'free-tenant'

    const localGroupConcurrencyConfig = {
      default: 1,
      tiers: {
        enterprise: 3
      }
    }

    const activeByGroup: Record<string, number> = {}
    const maxByGroup: Record<string, number> = {}

    // Send enterprise tier jobs
    for (let i = 0; i < 6; i++) {
      await ctx.boss.send(ctx.schema, { group: enterpriseGroup }, {
        group: { id: enterpriseGroup, tier: 'enterprise' }
      })
    }

    // Send free tier jobs
    for (let i = 0; i < 4; i++) {
      await ctx.boss.send(ctx.schema, { group: freeGroup }, {
        group: { id: freeGroup }
      })
    }

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 4,
      localGroupConcurrency: localGroupConcurrencyConfig,
      pollingIntervalSeconds: 0.5
    }, async (jobs) => {
      const job = jobs[0]
      const groupId = (job.data as { group: string }).group

      activeByGroup[groupId] = (activeByGroup[groupId] || 0) + 1
      maxByGroup[groupId] = Math.max(maxByGroup[groupId] || 0, activeByGroup[groupId])

      await delay(200)
      activeByGroup[groupId]--
    })

    await delay(5000)

    expect(maxByGroup[enterpriseGroup]).toBeDefined()
    expect(maxByGroup[freeGroup]).toBeDefined()
    expect(maxByGroup[enterpriseGroup]).toBeGreaterThanOrEqual(1)
    expect(maxByGroup[freeGroup]).toBeGreaterThanOrEqual(1)
  })

  it('should allow jobs without group to bypass localGroupConcurrency limits', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'limited-group'
    const localGroupConcurrency = 1

    let groupJobsProcessed = 0
    let noGroupJobsProcessed = 0

    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { hasGroup: true }, { group: { id: groupId } })
    }

    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { hasGroup: false })
    }

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 4,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5
    }, async (jobs) => {
      const job = jobs[0]
      if ((job.data as { hasGroup: boolean }).hasGroup) {
        groupJobsProcessed++
      } else {
        noGroupJobsProcessed++
      }
      await delay(200)
    })

    await delay(4000)

    // All jobs should have been processed
    expect(groupJobsProcessed).toBe(3)
    expect(noGroupJobsProcessed).toBe(3)
  })

  it('should validate localGroupConcurrency option in work', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // Invalid localGroupConcurrency (0)
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { localGroupConcurrency: 0 }, async () => {})
    }).rejects.toThrow('localGroupConcurrency must be an integer >= 1')

    // Invalid localGroupConcurrency object (missing default)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss!.work(ctx.schema, { localGroupConcurrency: { tiers: {} } }, async () => {})
    }).rejects.toThrow('localGroupConcurrency.default must be an integer >= 1')

    // Invalid tier limit
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, {
        localGroupConcurrency: { default: 1, tiers: { invalid: 0 } }
      }, async () => {})
    }).rejects.toThrow('localGroupConcurrency.tiers["invalid"] must be an integer >= 1')
  })

  it('should not allow both groupConcurrency and localGroupConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, {
        localConcurrency: 2,
        groupConcurrency: 2,
        localGroupConcurrency: 2
      }, async () => {})
    }).rejects.toThrow('cannot specify both groupConcurrency and localGroupConcurrency')
  })

  it('should not allow localGroupConcurrency to exceed localConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // Simple number exceeds localConcurrency
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, {
        localConcurrency: 2,
        localGroupConcurrency: 5
      }, async () => {})
    }).rejects.toThrow('localGroupConcurrency (5) cannot exceed localConcurrency (2)')

    // Default value exceeds localConcurrency
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, {
        localConcurrency: 2,
        localGroupConcurrency: { default: 5 }
      }, async () => {})
    }).rejects.toThrow('localGroupConcurrency.default (5) cannot exceed localConcurrency (2)')

    // Tier value exceeds localConcurrency
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, {
        localConcurrency: 2,
        localGroupConcurrency: { default: 1, tiers: { enterprise: 5 } }
      }, async () => {})
    }).rejects.toThrow('localGroupConcurrency.tiers["enterprise"] (5) cannot exceed localConcurrency (2)')
  })

  it('should use tier-specific limits when job has a tier in localGroupConcurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const premiumGroup = 'premium-tenant'
    const localGroupConcurrencyConfig = {
      default: 1,
      tiers: {
        premium: 2
      }
    }

    let maxActive = 0
    let currentActive = 0

    // Send premium tier jobs (should use limit of 2)
    for (let i = 0; i < 4; i++) {
      await ctx.boss.send(ctx.schema, { tier: 'premium', index: i }, {
        group: { id: premiumGroup, tier: 'premium' }
      })
    }

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 4,
      localGroupConcurrency: localGroupConcurrencyConfig,
      pollingIntervalSeconds: 0.5
    }, async () => {
      currentActive++
      maxActive = Math.max(maxActive, currentActive)
      await delay(300)
      currentActive--
    })

    await delay(4000)

    // Premium tier should allow up to 2 concurrent jobs per group
    expect(maxActive).toBeLessThanOrEqual(2)
  })

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

  it('should handle multiple groups reaching capacity simultaneously', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const group1 = 'capacity-group-1'
    const group2 = 'capacity-group-2'
    const localGroupConcurrency = 1
    const localConcurrency = 4

    const concurrentByGroup: Record<string, number> = { [group1]: 0, [group2]: 0 }
    const maxByGroup: Record<string, number> = { [group1]: 0, [group2]: 0 }
    let totalProcessed = 0

    // Send jobs for both groups
    for (let i = 0; i < 4; i++) {
      await ctx.boss.send(ctx.schema, { group: group1, index: i }, { group: { id: group1 } })
      await ctx.boss.send(ctx.schema, { group: group2, index: i }, { group: { id: group2 } })
    }

    await ctx.boss.work(ctx.schema, {
      localConcurrency,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5
    }, async (jobs) => {
      const job = jobs[0]
      const groupId = (job.data as { group: string }).group

      concurrentByGroup[groupId]++
      maxByGroup[groupId] = Math.max(maxByGroup[groupId], concurrentByGroup[groupId])

      await delay(600)

      concurrentByGroup[groupId]--
      totalProcessed++
    })

    await delay(8000)

    // Each group should respect its limit individually
    expect(maxByGroup[group1]).toBeLessThanOrEqual(localGroupConcurrency)
    expect(maxByGroup[group2]).toBeLessThanOrEqual(localGroupConcurrency)
    // All jobs should be processed
    expect(totalProcessed).toBe(8)
  })
})
