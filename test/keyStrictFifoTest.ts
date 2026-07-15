import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('key_strict_fifo', function () {
  // CockroachDB disables partitioning (noTablePartitioning), so only run the non-partitioned variant there
  const partitionCases = helper.isCockroachDb ? [{ partition: false }] : [{ partition: false }, { partition: true }]
  partitionCases.forEach(({ partition }) => {
    it(`key_strict_fifo policy requires singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      await expect(ctx.boss.send(ctx.schema, { test: 'data' }))
        .rejects.toThrow('key_strict_fifo queues require a singletonKey')
    })

    it(`key_strict_fifo policy allows sending with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      const jobId = await ctx.boss.send(ctx.schema, { test: 'data' }, { singletonKey: 'key-1' })

      expect(jobId).toBeTruthy()
    })

    it(`key_strict_fifo policy blocks queue during active state using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Send two jobs with the same singletonKey
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'order-123' })
      const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'order-123' })

      expect(jobId1).toBeTruthy()
      expect(jobId2).toBeTruthy()

      // Fetch the first job
      const [job1] = await ctx.boss.fetch(ctx.schema)
      expect(job1.id).toBe(jobId1)

      // Try to fetch the second job - should not be available because first is active
      const [job2] = await ctx.boss.fetch(ctx.schema)
      expect(job2).toBeFalsy()

      // Complete the first job
      await ctx.boss.complete(ctx.schema, job1.id)

      // Now the second job should be fetchable
      const [job2AfterComplete] = await ctx.boss.fetch(ctx.schema)
      expect(job2AfterComplete).toBeTruthy()
      expect(job2AfterComplete.id).toBe(jobId2)
    })

    it(`key_strict_fifo policy allows parallel processing of different singletonKeys using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Send jobs with different singletonKeys
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'order-123' })
      const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'order-456' })

      expect(jobId1).toBeTruthy()
      expect(jobId2).toBeTruthy()

      // Both jobs should be fetchable since they have different singletonKeys
      const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
      expect(jobs.length).toBe(2)
    })

    it(`key_strict_fifo policy blocks queue during retry state using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Send two jobs with the same singletonKey, first with retry enabled
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, {
        singletonKey: 'order-123',
        retryLimit: 2,
        retryDelay: 1
      })
      const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'order-123' })

      expect(jobId1).toBeTruthy()
      expect(jobId2).toBeTruthy()

      // Fetch and fail the first job - it should go to retry state
      const [job1] = await ctx.boss.fetch(ctx.schema)
      expect(job1.id).toBe(jobId1)

      await ctx.boss.fail(ctx.schema, job1.id)

      assertTruthy(jobId1)
      const job1WithData = await ctx.boss.getJobById(ctx.schema, jobId1)
      assertTruthy(job1WithData)
      expect(job1WithData.state).toBe('retry')

      // The second job should NOT be fetchable because first is in retry
      const [job2] = await ctx.boss.fetch(ctx.schema)
      expect(job2).toBeFalsy()

      // Wait for retry delay and fetch again - should get the first job again
      await delay(1500)
      const [job1Retry] = await ctx.boss.fetch(ctx.schema)
      expect(job1Retry).toBeTruthy()
      expect(job1Retry.id).toBe(jobId1)

      // Complete the retried job
      await ctx.boss.complete(ctx.schema, job1Retry.id)

      // Now the second job should be fetchable
      const [job2AfterComplete] = await ctx.boss.fetch(ctx.schema)
      expect(job2AfterComplete).toBeTruthy()
      expect(job2AfterComplete.id).toBe(jobId2)
    })

    it(`key_strict_fifo policy blocks queue permanently on failure using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Send two jobs with the same singletonKey, first with no retries
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, {
        singletonKey: 'order-123',
        retryLimit: 0
      })
      const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'order-123' })

      expect(jobId1).toBeTruthy()
      expect(jobId2).toBeTruthy()

      // Fetch and fail the first job - it should go to failed state
      const [job1] = await ctx.boss.fetch(ctx.schema)
      expect(job1.id).toBe(jobId1)

      await ctx.boss.fail(ctx.schema, job1.id)

      assertTruthy(jobId1)
      const job1WithData = await ctx.boss.getJobById(ctx.schema, jobId1)
      assertTruthy(job1WithData)
      expect(job1WithData.state).toBe('failed')

      // The second job should NOT be fetchable because first is failed
      const [job2] = await ctx.boss.fetch(ctx.schema)
      expect(job2).toBeFalsy()
    })

    it(`key_strict_fifo policy unblocks queue when failed job is deleted using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Send two jobs with the same singletonKey
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, {
        singletonKey: 'order-123',
        retryLimit: 0
      })
      const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'order-123' })

      // Fetch and fail the first job
      const [job1] = await ctx.boss.fetch(ctx.schema)
      await ctx.boss.fail(ctx.schema, job1.id)

      // Verify queue is blocked
      const [blockedJob] = await ctx.boss.fetch(ctx.schema)
      expect(blockedJob).toBeFalsy()

      // Delete the failed job
      assertTruthy(jobId1)
      await ctx.boss.deleteJob(ctx.schema, jobId1)

      // Now the second job should be fetchable
      const [job2] = await ctx.boss.fetch(ctx.schema)
      expect(job2).toBeTruthy()
      expect(job2.id).toBe(jobId2)
    })

    it(`key_strict_fifo policy unblocks queue when failed job is retried using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Send two jobs with the same singletonKey
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, {
        singletonKey: 'order-123',
        retryLimit: 0
      })
      const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'order-123' })

      // Fetch and fail the first job
      const [job1] = await ctx.boss.fetch(ctx.schema)
      await ctx.boss.fail(ctx.schema, job1.id)

      // Verify queue is blocked
      const [blockedJob] = await ctx.boss.fetch(ctx.schema)
      expect(blockedJob).toBeFalsy()

      // Retry the failed job
      assertTruthy(jobId1)
      await ctx.boss.retry(ctx.schema, jobId1)

      // The retried job should be fetchable (it goes back to retry state with incremented retry limit)
      const [retriedJob] = await ctx.boss.fetch(ctx.schema)
      expect(retriedJob).toBeTruthy()
      expect(retriedJob.id).toBe(jobId1)

      // Complete it
      await ctx.boss.complete(ctx.schema, retriedJob.id)

      // Now the second job should be fetchable
      const [job2] = await ctx.boss.fetch(ctx.schema)
      expect(job2).toBeTruthy()
      expect(job2.id).toBe(jobId2)
    })

    // The four tests below cover key_strict_fifo blocking - the rule "is another job of this key
    // already in flight or stuck?" (a sibling in active/retry/failed). key_strict_fifo used to rely
    // only on the job_i8 unique index: fetch tried to activate a blocked key's job, hit a unique
    // violation (23505), and manager.fetch() swallowed it as an empty result - so on a batch fetch
    // one stuck/failed key starved every other key. The fix skips blocked keys in fetchNextJob, so
    // a blocked key only holds back its own successors while every other key keeps flowing.
    it(`key_strict_fifo failed key does not block other keys using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // A1, A2 share a key (A2 is the head of A's queue after A1 fails); B1 is a different key
      const jobIdA1 = await ctx.boss.send(ctx.schema, { key: 'A', order: 1 }, { singletonKey: 'A', retryLimit: 0 })
      const jobIdA2 = await ctx.boss.send(ctx.schema, { key: 'A', order: 2 }, { singletonKey: 'A' })
      const jobIdB1 = await ctx.boss.send(ctx.schema, { key: 'B', order: 1 }, { singletonKey: 'B' })

      expect(jobIdA1).toBeTruthy()
      expect(jobIdA2).toBeTruthy()
      expect(jobIdB1).toBeTruthy()

      // Fetch and permanently fail A1
      const [jobA1] = await ctx.boss.fetch(ctx.schema)
      expect(jobA1.id).toBe(jobIdA1)
      await ctx.boss.fail(ctx.schema, jobA1.id)

      assertTruthy(jobIdA1)
      const failedA1 = await ctx.boss.getJobById(ctx.schema, jobIdA1)
      assertTruthy(failedA1)
      expect(failedA1.state).toBe('failed')

      // B1 must still be fetchable even though A is blocked at the head of the queue
      const [jobB1] = await ctx.boss.fetch(ctx.schema)
      expect(jobB1).toBeTruthy()
      expect(jobB1.id).toBe(jobIdB1)

      // A2 must NOT be fetchable while A1 is failed
      const [blocked] = await ctx.boss.fetch(ctx.schema)
      expect(blocked).toBeFalsy()
    })

    it(`key_strict_fifo recovers successors in order after retry using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      const jobIdA1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'A', retryLimit: 0 })
      const jobIdA2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'A' })

      // Fetch and fail A1
      const [jobA1] = await ctx.boss.fetch(ctx.schema)
      await ctx.boss.fail(ctx.schema, jobA1.id)

      // Queue for key A is blocked
      const [blocked] = await ctx.boss.fetch(ctx.schema)
      expect(blocked).toBeFalsy()

      // Retry the failed job - A1 becomes fetchable again (retry state), A2 stays queued
      assertTruthy(jobIdA1)
      await ctx.boss.retry(ctx.schema, jobIdA1)

      const [retriedA1] = await ctx.boss.fetch(ctx.schema)
      expect(retriedA1).toBeTruthy()
      expect(retriedA1.id).toBe(jobIdA1)

      // A2 still not fetchable while A1 is active
      const [stillBlocked] = await ctx.boss.fetch(ctx.schema)
      expect(stillBlocked).toBeFalsy()

      // Once A1 completes, A2 becomes fetchable
      await ctx.boss.complete(ctx.schema, retriedA1.id)

      const [jobA2] = await ctx.boss.fetch(ctx.schema)
      expect(jobA2).toBeTruthy()
      expect(jobA2.id).toBe(jobIdA2)
    })

    it(`key_strict_fifo active key does not block other keys using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // A1 older than A2; B1 is a different key
      const jobIdA1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'A' })
      const jobIdA2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'A' })
      const jobIdB1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'B' })

      expect(jobIdA1).toBeTruthy()
      expect(jobIdA2).toBeTruthy()
      expect(jobIdB1).toBeTruthy()

      // Fetch A1, leave it active (do not complete)
      const [jobA1] = await ctx.boss.fetch(ctx.schema)
      expect(jobA1.id).toBe(jobIdA1)

      // A2 is older than B1 so it sorts first, but it is blocked while A1 is active. A default
      // (single-row) fetch must skip A2 before applying LIMIT and return B1 rather than nothing.
      const [jobB1] = await ctx.boss.fetch(ctx.schema)
      expect(jobB1).toBeTruthy()
      expect(jobB1.id).toBe(jobIdB1)
    })

    it(`key_strict_fifo batch fetch dedups same key using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      const jobIdA1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'A' })
      const jobIdA2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'A' })
      const jobIdB1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'B' })

      expect(jobIdA1).toBeTruthy()
      expect(jobIdA2).toBeTruthy()
      expect(jobIdB1).toBeTruthy()

      // A single batch fetch must return one job per key (the oldest) and must not try to
      // activate two same-key jobs in one statement, which would violate job_i8 and abort the
      // whole fetch. Before the fix this returned an empty/partial batch instead of [A1, B1].
      const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 3 })
      const fetchedIds = jobs.map(job => job.id).sort()
      expect(fetchedIds).toEqual([jobIdA1, jobIdB1].sort())
    })

    // The two tests below cover key_strict_fifo ordering - the rule "among this key's waiting jobs,
    // is this the oldest?". Priority may order across keys, but never within a key. Before the fix
    // the per-key dedup ran after the priority/LIMIT ordering, so a newer higher-priority job could
    // jump ahead of an older one with the same key.
    it(`key_strict_fifo priority does not reorder within a key using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Same key: older job at priority 0, newer job at priority 10. The older one must come back
      // first - within a key the oldest always wins, regardless of priority.
      const older = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'A', priority: 0 })
      const newer = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'A', priority: 10 })

      const [first] = await ctx.boss.fetch(ctx.schema)
      expect(first.id).toBe(older)

      await ctx.boss.complete(ctx.schema, first.id)

      const [second] = await ctx.boss.fetch(ctx.schema)
      expect(second.id).toBe(newer)
    })

    it(`key_strict_fifo batch does not surface a newer high-priority same-key job using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // A's older job is low priority, its newer job is high priority, with other keys in between.
      // A's oldest queued job is its only eligible candidate, so a batch fetch must never return A's
      // newer job while the older one is still queued - whatever the priorities or batch size.
      const olderA = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'A', priority: 0 })
      const newerA = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'A', priority: 10 })
      await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'B', priority: 5 })
      await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'C', priority: 5 })

      assertTruthy(olderA)
      assertTruthy(newerA)

      const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
      const fetchedIds = jobs.map(job => job.id)

      expect(fetchedIds).not.toContain(newerA)
    })

    it(`getBlockedKeys returns blocked singletonKeys using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Initially no blocked keys
      const blockedKeys1 = await ctx.boss.getBlockedKeys(ctx.schema)
      expect(blockedKeys1).toEqual([])

      // Send and fail a job
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, {
        singletonKey: 'order-123',
        retryLimit: 0
      })
      const [job1] = await ctx.boss.fetch(ctx.schema)
      await ctx.boss.fail(ctx.schema, job1.id)

      // Should have one blocked key
      const blockedKeys2 = await ctx.boss.getBlockedKeys(ctx.schema)
      expect(blockedKeys2).toContain('order-123')

      // Fail another job with different singletonKey
      await ctx.boss.send(ctx.schema, { order: 2 }, {
        singletonKey: 'order-456',
        retryLimit: 0
      })
      const [job2] = await ctx.boss.fetch(ctx.schema)
      await ctx.boss.fail(ctx.schema, job2.id)

      // Should have two blocked keys
      const blockedKeys3 = await ctx.boss.getBlockedKeys(ctx.schema)
      expect(blockedKeys3).toHaveLength(2)
      expect(blockedKeys3).toContain('order-123')
      expect(blockedKeys3).toContain('order-456')

      // Delete one failed job
      assertTruthy(jobId1)
      await ctx.boss.deleteJob(ctx.schema, jobId1)

      // Should have one blocked key
      const blockedKeys4 = await ctx.boss.getBlockedKeys(ctx.schema)
      expect(blockedKeys4).toHaveLength(1)
      expect(blockedKeys4).toContain('order-456')
    })

    it(`getBlockedKeys throws for non-key_strict_fifo queues using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'standard', partition })

      await expect(ctx.boss.getBlockedKeys(ctx.schema))
        .rejects.toThrow('getBlockedKeys is only available for key_strict_fifo queues')
    })

    it(`key_strict_fifo policy insert requires singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      await expect(ctx.boss.insert(ctx.schema, [{ data: { test: 'data' } }]))
        .rejects.toThrow('key_strict_fifo queues require a singletonKey')
    })

    it(`key_strict_fifo policy insert works with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo', partition })

      // Insert should not throw when singletonKeys are provided
      await ctx.boss.insert(ctx.schema, [
        { data: { order: 1 }, singletonKey: 'order-123' },
        { data: { order: 2 }, singletonKey: 'order-456' }
      ])

      // Verify the jobs were inserted by fetching them
      const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
      expect(jobs).toHaveLength(2)
    })
  })

  it('key_strict_fifo policy rejects direct SQL insert with NULL singleton_key', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo' })

    // Direct SQL insert with NULL singleton_key should be rejected by CHECK constraint
    const db = ctx.boss.getDb()
    const schema = ctx.bossConfig.schema || 'pgboss'

    await expect(db.executeSql(`
      INSERT INTO ${schema}.job_common (name, data, policy)
      VALUES ($1, $2, 'key_strict_fifo')
    `, [ctx.schema, JSON.stringify({ test: 'data' })]))
      .rejects.toThrow(/singleton_key/)
  })
})
