import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('localGroupConcurrency (tier & retry)', function () {
  it('excess jobs restored by localGroupConcurrency should not have retry_count inflated on re-fetch', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const groupId = 'test-group'

    // Send 2 jobs for the same group. With batchSize: 2 and a single worker,
    // both jobs are fetched in the same query and both are set to active in the
    // DB. localGroupConcurrency: 1 then allows the first and marks the second
    // as excess. Before the fix, restoreJobs only reset state to 'created' and
    // left started_on set, causing retry_count to be inflated on re-fetch.
    const jobId1 = await ctx.boss.send(ctx.schema, {}, { group: { id: groupId }, retryLimit: 0 })
    const jobId2 = await ctx.boss.send(ctx.schema, {}, { group: { id: groupId }, retryLimit: 0 })
    assertTruthy(jobId1)
    assertTruthy(jobId2)

    await ctx.boss.work(ctx.schema, {
      localConcurrency: 1,
      localGroupConcurrency: 1,
      batchSize: 2,
      pollingIntervalSeconds: 0.5
    }, async () => {})

    await spy.waitForJobWithId(jobId1, 'completed')
    await spy.waitForJobWithId(jobId2, 'completed')

    const result = await helper.findJobs(ctx.schema, 'id = ANY($1::uuid[])', [[jobId1, jobId2]])
    expect(result.rows.length).toBe(2)
    for (const row of result.rows) {
      // Regression: the excess-restored job previously had retry_count = 1 even
      // though neither job was actually retried. restoreJobs now clears started_on
      // so the next fetch sees started_on IS NULL and does not increment retry_count.
      expect(row.retry_count).toBe(0)
    }
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

  it('should fetch enterprise-tier jobs for a group that is at its default limit', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const groupId = 'test-group'
    const localGroupConcurrency = { default: 1, tiers: { enterprise: 3 } }

    let enterpriseJobsProcessed = 0

    // Resolved from inside the handler the moment the default-tier job starts,
    // giving a hard synchronisation point before enterprise jobs are enqueued.
    let signalDefaultJobActive: () => void
    const defaultJobActive = new Promise<void>(resolve => { signalDefaultJobActive = resolve })

    // Start the worker before sending jobs so we can control ordering precisely.
    await ctx.boss.work(ctx.schema, {
      localConcurrency: 3,
      localGroupConcurrency,
      pollingIntervalSeconds: 0.5
    }, async ([job]) => {
      if ((job.data as { tier: string }).tier === 'default') {
        signalDefaultJobActive() // in-memory count is now 1
        await delay(5000) // hold active for the full test window
      } else {
        enterpriseJobsProcessed++
      }
    })

    // Send the default-tier job and wait for a hard signal that it is active and
    // the in-memory count has been incremented before enqueueing enterprise jobs.
    await ctx.boss.send(ctx.schema, { tier: 'default' }, { group: { id: groupId } })
    await defaultJobActive

    // Regression coverage: previously #getGroupsAtLocalCapacity compared against
    // config.default only, so once the group had one active job it was added to
    // ignoreGroups and all its enterprise-tier jobs were excluded from fetching
    // entirely, even though the enterprise limit of 3 had capacity remaining.
    await ctx.boss.send(ctx.schema, { tier: 'enterprise' }, { group: { id: groupId, tier: 'enterprise' } })
    await ctx.boss.send(ctx.schema, { tier: 'enterprise' }, { group: { id: groupId, tier: 'enterprise' } })

    // Several polling cycles for the available workers to pick up enterprise jobs.
    await delay(3000)

    // Both enterprise jobs should be processed — the group is at its default limit
    // but the enterprise tier still has capacity.
    expect(enterpriseJobsProcessed).toBe(2)
  })
})
