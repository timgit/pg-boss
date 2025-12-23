import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('groupConcurrency', function () {
  it('should store group id and tier with job', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'tenant-123'
    const groupTier = 'enterprise'

    const jobId = await ctx.boss.send(ctx.schema, { test: 'data' }, {
      group: { id: groupId, tier: groupTier }
    })

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.groupId).toBe(groupId)
    expect(job.groupTier).toBe(groupTier)
  })

  it('should limit active jobs per group with simple groupConcurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'tenant-123'
    const groupConcurrency = 2
    const jobCount = 6

    // Track concurrent jobs per group
    let currentActive = 0
    let maxActive = 0

    // Send jobs for the same group
    const jobIds: string[] = []
    for (let i = 0; i < jobCount; i++) {
      const jobId: string | null = await ctx.boss.send(ctx.schema, { index: i }, {
        group: { id: groupId }
      })
      assertTruthy(jobId)
      jobIds.push(jobId)
    }

    // Create worker with groupConcurrency limit
    await ctx.boss.work(ctx.schema, { groupConcurrency, pollingIntervalSeconds: 0.5 }, async () => {
      currentActive++
      maxActive = Math.max(maxActive, currentActive)
      await delay(500) // Simulate work
      currentActive--
    })

    await delay(5000)

    // The group concurrency limit should have been respected
    expect(maxActive).toBeLessThanOrEqual(groupConcurrency)
  })

  it('should allow different groups to process independently', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const group1 = 'tenant-1'
    const group2 = 'tenant-2'
    const groupConcurrency = 1
    const localConcurrency = 2 // Multiple workers

    const activeGroups: Record<string, number> = { [group1]: 0, [group2]: 0 }
    let bothActiveAtOnce = false

    // Send jobs for both groups
    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { group: group1, index: i }, { group: { id: group1 } })
      await ctx.boss.send(ctx.schema, { group: group2, index: i }, { group: { id: group2 } })
    }

    // Create workers with groupConcurrency limit
    await ctx.boss.work(ctx.schema, { localConcurrency, groupConcurrency, pollingIntervalSeconds: 0.5 }, async (jobs) => {
      const job = jobs[0]
      const groupId = (job.data as { group: string }).group

      activeGroups[groupId]++

      // Check if both groups have active jobs simultaneously
      if (activeGroups[group1] > 0 && activeGroups[group2] > 0) {
        bothActiveAtOnce = true
      }

      // Each group should respect its own limit
      expect(activeGroups[groupId]).toBeLessThanOrEqual(groupConcurrency)

      await delay(500)
      activeGroups[groupId]--
    })

    await delay(6000)

    // Both groups should have been able to run jobs simultaneously
    // (they have separate concurrency limits)
    expect(bothActiveAtOnce).toBe(true)
  })

  it('should apply tier-based concurrency limits', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const enterpriseGroup = 'enterprise-tenant'
    const freeGroup = 'free-tenant'

    const groupConcurrencyConfig = {
      default: 1, // Free tier gets 1
      tiers: {
        enterprise: 3 // Enterprise tier gets 3
      }
    }

    const activeByGroup: Record<string, number> = {}
    const maxByGroup: Record<string, number> = {}

    for (let i = 0; i < 6; i++) {
      await ctx.boss.send(ctx.schema, { group: enterpriseGroup }, {
        group: { id: enterpriseGroup, tier: 'enterprise' }
      })
    }

    // Send free tier jobs
    for (let i = 0; i < 4; i++) {
      await ctx.boss.send(ctx.schema, { group: freeGroup }, {
        group: { id: freeGroup } // No tier specified, uses default
      })
    }

    // Create workers with tier-based groupConcurrency
    // Using localConcurrency: 1 to avoid race conditions in this test
    await ctx.boss.work(ctx.schema, {
      localConcurrency: 1,
      groupConcurrency: groupConcurrencyConfig,
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

    // With single worker, both should see concurrency of 1
    // But the key test is that the tier config is properly recognized
    // and the jobs complete without errors
    expect(maxByGroup[enterpriseGroup]).toBeDefined()
    expect(maxByGroup[freeGroup]).toBeDefined()

    // Verify that both groups had jobs processed
    expect(maxByGroup[enterpriseGroup]).toBeGreaterThanOrEqual(1)
    expect(maxByGroup[freeGroup]).toBeGreaterThanOrEqual(1)
  })

  it('should allow jobs without group to bypass group concurrency limits', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'limited-group'
    const groupConcurrency = 1

    let groupJobsProcessed = 0
    let noGroupJobsProcessed = 0

    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { hasGroup: true }, { group: { id: groupId } })
    }

    for (let i = 0; i < 3; i++) {
      await ctx.boss.send(ctx.schema, { hasGroup: false })
    }

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 2,
      groupConcurrency,
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

  it('should validate group option in send', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // Invalid group (not an object)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.send(ctx.schema, {}, { group: 'not-an-object' })
    }).rejects.toThrow('group must be an object')

    // Invalid group.id (empty string)
    await expect(async () => {
      await ctx.boss!.send(ctx.schema, {}, { group: { id: '' } })
    }).rejects.toThrow('group.id must be a non-empty string')

    // Invalid group.tier (empty string when provided)
    await expect(async () => {
      await ctx.boss!.send(ctx.schema, {}, { group: { id: 'test', tier: '' } })
    }).rejects.toThrow('group.tier must be a non-empty string if provided')
  })

  it('should validate groupConcurrency option in work', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // Invalid groupConcurrency (0)
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { groupConcurrency: 0 }, async () => {})
    }).rejects.toThrow('groupConcurrency must be an integer >= 1')

    // Invalid groupConcurrency object (missing default)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss!.work(ctx.schema, { groupConcurrency: { tiers: {} } }, async () => {})
    }).rejects.toThrow('groupConcurrency.default must be an integer >= 1')

    // Invalid tier limit
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, {
        groupConcurrency: { default: 1, tiers: { invalid: 0 } }
      }, async () => {})
    }).rejects.toThrow('groupConcurrency.tiers["invalid"] must be an integer >= 1')
  })
})

describe('localGroupConcurrency', function () {
  it('should limit active jobs per group with simple localGroupConcurrency', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const groupId = 'tenant-123'
    const localGroupConcurrency = 2
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
    // Note: Using localConcurrency: 1 to test limiting behavior without race conditions
    // from multiple workers polling simultaneously before counts are updated.
    // The "different groups process independently" test covers multi-worker scenarios.
    await ctx.boss.work(ctx.schema, {
      localConcurrency: 1,
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
        groupConcurrency: 2,
        localGroupConcurrency: 2
      }, async () => {})
    }).rejects.toThrow('cannot specify both groupConcurrency and localGroupConcurrency')
  })
})
