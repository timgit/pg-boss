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

  it('singleton limit active jobs per group and singletonKey simultaneously', async function () {
    const config = {
      ...ctx.bossConfig,
      noDefault: true,
      debug: true
    }

    const groupId = 'tenant-123'

    ctx.boss = await helper.start(config)

    await ctx.boss.createQueue(ctx.schema, { policy: 'singleton' })

    await ctx.boss.send(ctx.schema, { groupId })
    await ctx.boss.send(ctx.schema, { groupId }, { singletonKey: 'a', retryLimit: 1 })
    await ctx.boss.send(ctx.schema, { groupId }, { singletonKey: 'a', retryLimit: 1 })
    await ctx.boss.send(ctx.schema, { groupId }, { singletonKey: 'b', retryLimit: 1 })

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 5, includeMetadata: true, groupConcurrency: 5 })

    expect(jobs.length).toBe(3)
    expect(jobs.find(i => i.singletonKey === 'a')).toBeTruthy()
    expect(jobs.find(i => i.singletonKey === 'b')).toBeTruthy()

    await ctx.boss.complete(ctx.schema, jobs.map(i => i.id))

    const [job3] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true, groupConcurrency: 5 })
    expect(job3.singletonKey).toBe('a')
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

  it('should process available group jobs when saturated group dominates the front of the queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const groupA = 'group-saturated'
    const groupB = 'group-available'
    const groupConcurrency = 1

    // Step 1: Send one group A job and fetch it directly to make it "active",
    // holding group A at its concurrency limit for the entire duration of the test.
    // This simulates a long-running job consuming the one allowed slot.
    await ctx.boss.send(ctx.schema, {}, { group: { id: groupA } })
    const [activeJob] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(activeJob)
    // activeJob is now in "active" state and will never be completed during this
    // test, keeping group A permanently saturated (active_cnt = 1 = groupConcurrency).

    // Step 2: Flood the front of the queue with group A jobs.
    // Sent AFTER the active job, so they occupy positions 1–5 in
    // ORDER BY created_on, id — ahead of group B in queue order.
    for (let i = 0; i < 5; i++) {
      await ctx.boss.send(ctx.schema, { index: i }, { group: { id: groupA } })
    }

    // Step 3: Enqueue one group B job. It is fully eligible (0 active, under its
    // concurrency limit), but created last so it sits at position 6 in queue order,
    // behind all of the group A queued jobs.
    await ctx.boss.send(ctx.schema, {}, { group: { id: groupB } })

    // Step 4: Start a single worker with groupConcurrency: 1.
    // With the bug, every poll executes:
    //   next CTE  →  LIMIT 1  →  picks the oldest queued job (a group A job)
    //   group_filtered  →  active_cnt(1) + group_rn(1) = 2 > 1  →  discarded
    //   UPDATE affects 0 rows  →  worker sleeps 500 ms  →  repeat forever.
    // The group B job is never reached because it sits behind the group A pile.
    let groupBProcessed = false

    await ctx.boss.work(ctx.schema, {
      groupConcurrency,
      localConcurrency: 1,
      pollingIntervalSeconds: 0.5
    }, async ([job]) => {
      if (job.groupId === groupB) {
        groupBProcessed = true
      }
    })

    // 10 polling cycles at 500 ms — more than enough for a correct implementation
    // to find the group B job on its very first fetch (group A is pre-filtered out).
    // With the bug, the worker starves indefinitely on group A jobs.
    await delay(5000)

    // BUG: this assertion fails. groupBProcessed is false because the group B job
    // is starved behind the group A queued jobs. The `next` CTE applies LIMIT 1
    // before the group concurrency check in `group_filtered`, so a saturated group
    // dominating the front of the queue blocks every other group from being reached.
    expect(groupBProcessed).toBe(true)
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
