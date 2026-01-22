import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('singleton_strict_fifo', function () {
  [{ partition: false }, { partition: true }].forEach(({ partition }) => {
    it(`singleton_strict_fifo policy requires singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

      await expect(ctx.boss.send(ctx.schema, { test: 'data' }))
        .rejects.toThrow('singleton_strict_fifo queues require a singletonKey')
    })

    it(`singleton_strict_fifo policy allows sending with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

      const jobId = await ctx.boss.send(ctx.schema, { test: 'data' }, { singletonKey: 'key-1' })

      expect(jobId).toBeTruthy()
    })

    it(`singleton_strict_fifo policy blocks queue during active state using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

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

    it(`singleton_strict_fifo policy allows parallel processing of different singletonKeys using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

      // Send jobs with different singletonKeys
      const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 }, { singletonKey: 'order-123' })
      const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 }, { singletonKey: 'order-456' })

      expect(jobId1).toBeTruthy()
      expect(jobId2).toBeTruthy()

      // Both jobs should be fetchable since they have different singletonKeys
      const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
      expect(jobs.length).toBe(2)
    })

    it(`singleton_strict_fifo policy blocks queue during retry state using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

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

    it(`singleton_strict_fifo policy blocks queue permanently on failure using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

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

    it(`singleton_strict_fifo policy unblocks queue when failed job is deleted using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

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

    it(`singleton_strict_fifo policy unblocks queue when failed job is retried using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

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

    it(`getBlockedKeys returns blocked singletonKeys using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

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

    it(`getBlockedKeys throws for non-singleton_strict_fifo queues using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'standard', partition })

      await expect(ctx.boss.getBlockedKeys(ctx.schema))
        .rejects.toThrow('getBlockedKeys is only available for singleton_strict_fifo queues')
    })

    it(`singleton_strict_fifo policy insert requires singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

      await expect(ctx.boss.insert(ctx.schema, [{ data: { test: 'data' } }]))
        .rejects.toThrow('singleton_strict_fifo queues require a singletonKey')
    })

    it(`singleton_strict_fifo policy insert works with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton_strict_fifo', partition })

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
})
