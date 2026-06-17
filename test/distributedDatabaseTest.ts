import { expect, describe, it } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

// These tests assert invariants that are SPECIFIC to distributed database mode and are not covered
// by the rest of the suite. The general behavioral coverage (fetch/complete/retry/priority/
// concurrency/singleton/policies/...) runs against CockroachDB automatically via
// `npm run test:cockroachdb`, where testHelper.getConfig() turns on distributedDatabaseMode for
// every test. The cases below stay here because they either exercise distributed-only code paths
// (completeDistributed/failDistributed, the no-lock fetch contention guard, the CockroachDB
// compatibility construction branches) or rely on internals (db injection) that don't fit a
// generic test. They explicitly opt into distributedDatabaseMode, so they also provide
// distributed-on-Postgres coverage during the normal `npm test` run.
// Every test here calls helper.start(), which on CockroachDB pays slow per-test DDL (~8-9s
// observed in CI), leaving little headroom under the 10s global timeout. Raise the default for
// the whole block so startup jitter can't push a test over the edge (the concurrency tests below
// keep their explicit per-test overrides).
describe('distributed database mode', { timeout: 20000 }, function () {
  it('should not duplicate jobs when fetching concurrently in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })
    const jobCount = 10

    await Promise.all(
      Array.from({ length: jobCount }, (_, i) => ctx.boss!.send(ctx.schema, { index: i }))
    )

    // Fetch concurrently from multiple "workers"
    const results = await Promise.all([
      ctx.boss.fetch(ctx.schema, { batchSize: jobCount }),
      ctx.boss.fetch(ctx.schema, { batchSize: jobCount }),
      ctx.boss.fetch(ctx.schema, { batchSize: jobCount })
    ])

    const allJobs = results.flat()

    // Each job should only be fetched once (no duplicates)
    // This is the key guarantee of the distributed mode
    const jobIds = allJobs.map(j => j.id)
    const uniqueJobIds = new Set(jobIds)
    expect(uniqueJobIds.size).toBe(jobIds.length)

    // Due to concurrent contention, not all jobs may be claimed in one round
    // but no job should be duplicated
    expect(allJobs.length).toBeLessThanOrEqual(jobCount)
    expect(allJobs.length).toBeGreaterThan(0)
  }, 30000)

  it('should handle high concurrency without duplicates in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })
    const jobCount = 50
    const workerCount = 10

    // Send many jobs
    await Promise.all(
      Array.from({ length: jobCount }, (_, i) => ctx.boss!.send(ctx.schema, { index: i }))
    )

    // Simulate many concurrent workers fetching jobs
    const results = await Promise.all(
      Array.from({ length: workerCount }, () =>
        ctx.boss!.fetch(ctx.schema, { batchSize: jobCount })
      )
    )

    // Flatten all fetched jobs
    const allJobs = results.flat()

    // Verify no duplicates
    const jobIds = allJobs.map(j => j.id)
    const uniqueJobIds = new Set(jobIds)
    expect(uniqueJobIds.size).toBe(jobIds.length) // No duplicates

    // All jobs should eventually be claimed (may need multiple rounds under contention)
    // Due to concurrent contention, we may not get all jobs in one round
    expect(allJobs.length).toBeLessThanOrEqual(jobCount)
    expect(allJobs.length).toBeGreaterThan(0)

    // Track which job indices were claimed
    const claimedIndices = new Set(allJobs.map(j => (j.data as { index: number }).index))

    // Fetch remaining jobs
    let remainingJobs = await ctx.boss.fetch(ctx.schema, { batchSize: jobCount })
    while (remainingJobs.length > 0) {
      for (const job of remainingJobs) {
        const index = (job.data as { index: number }).index
        // Verify this job wasn't already claimed
        expect(claimedIndices.has(index)).toBe(false)
        claimedIndices.add(index)
      }
      remainingJobs = await ctx.boss.fetch(ctx.schema, { batchSize: jobCount })
    }

    // Verify all jobs were claimed exactly once
    expect(claimedIndices.size).toBe(jobCount)
  }, 30000)

  it('should return 0 when failing non-existent job ids in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    // Try to fail a job that doesn't exist (using a valid UUID format)
    const result = await ctx.boss.fail(ctx.schema, '00000000-0000-0000-0000-000000000000')
    expect(result.affected).toBe(0)
  })

  it('should insert to dead letter queue when failing without retries in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    // Send a job with no retries
    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0 })
    helper.assertTruthy(jobId)

    // Fetch and fail the job
    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId, { error: 'test error' })

    // Should have a job in the dead letter queue
    const [dlqJob] = await ctx.boss.fetch<{ key: string }>(deadLetter)
    expect(dlqJob).toBeTruthy()
    expect(dlqJob.data.key).toBe(ctx.schema)
  })

  it('should rollback transaction on error in distributed mode fail', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    // Send a job
    const jobId = await ctx.boss.send(ctx.schema, { test: 'rollback' }, { retryLimit: 1 })
    helper.assertTruthy(jobId)

    // Fetch the job
    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()

    // Create a custom db that throws an error during the INSERT step
    const _db = await helper.getDb()
    let callCount = 0
    const db = {
      // @ts-ignore
      async executeSql (sql: string, values: any[]) {
        callCount++
        // Throw error after SELECT and DELETE (calls 3 and 4), during INSERT
        if (callCount === 5) {
          throw new Error('Simulated database error')
        }
        // @ts-ignore
        return _db.pool.query(sql, values)
      }
    }

    // The fail should throw due to the simulated error
    await expect(async () => {
      await ctx.boss.fail(ctx.schema, jobId, null, { db })
    }).rejects.toThrow('Simulated database error')

    // Job should still be in active state (transaction was rolled back)
    const jobData = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(jobData)
    expect(jobData.state).toBe('active')

    await _db.close()
  })

  it('should unblock dependent jobs when completing a parent in distributed mode', async function () {
    // Exercises completeDistributed()'s separate dependency-unblock statement
    // (plans.completeJobsDistributed + plans.decrementDependents)
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, data: { child: true }, dependsOn: ['parent'] }
    ])

    // Child starts blocked, only the parent is fetchable
    const childBefore = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(childBefore)
    expect(childBefore.blocked).toBe(true)

    const [parent] = await ctx.boss.fetch(ctx.schema)
    expect(parent.id).toBe(flow.parent)

    await ctx.boss.complete(ctx.schema, parent.id)

    // Completing the blocking parent must decrement the child's pending_dependencies
    const childAfter = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(childAfter)
    expect(childAfter.blocked).toBe(false)
    expect(childAfter.pendingDependencies).toBe(0)

    const [unblocked] = await ctx.boss.fetch(ctx.schema)
    expect(unblocked).toBeTruthy()
    expect(unblocked.id).toBe(flow.child)
  })

  it('should rollback transaction on error in distributed mode complete', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'rollback' })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()

    const _db = await helper.getDb()
    let callCount = 0
    const db = {
      // @ts-ignore
      async executeSql (sql: string, values: any[]) {
        callCount++
        // First call is BEGIN; throw on the completion statement that follows
        if (callCount === 2) {
          throw new Error('Simulated database error')
        }
        // @ts-ignore
        return _db.pool.query(sql, values)
      }
    }

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.complete(ctx.schema, jobId, null, { db })
    }).rejects.toThrow('Simulated database error')

    // The transaction was rolled back, so the job is still active
    const jobData = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(jobData)
    expect(jobData.state).toBe('active')

    await _db.close()
  })

  it('should normalize numeric metadata fields in distributed mode', async function () {
    // Exercises the numeric-field normalization for includeMetadata fetches
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    await ctx.boss.send(ctx.schema, { value: 'meta' }, {
      retryLimit: 5,
      retryDelay: 7,
      expireInSeconds: 120
    })

    const [job] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true })
    helper.assertTruthy(job)

    expect(typeof job.priority).toBe('number')
    expect(typeof job.retryLimit).toBe('number')
    expect(typeof job.retryCount).toBe('number')
    expect(typeof job.retryDelay).toBe('number')
    expect(typeof job.expireInSeconds).toBe('number')

    expect(job.retryLimit).toBe(5)
    expect(job.retryDelay).toBe(7)
    expect(job.expireInSeconds).toBe(120)
    expect(job.retryCount).toBe(0)
  })

  it('should construct schema with all distributed compatibility flags', async function () {
    // Exercises the CockroachDB-oriented construction branches (no partitioning,
    // non-deferrable constraints, non-covering indexes, no advisory locks)
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      distributedDatabaseMode: true,
      noTablePartitioning: true,
      noDeferrableConstraints: true,
      noCoveringIndexes: true,
      noAdvisoryLocks: true
    })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'flags' })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()
    expect(job.id).toBe(jobId)

    await ctx.boss.complete(ctx.schema, jobId)

    const completed = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(completed)
    expect(completed.state).toBe('completed')
  })

  it('should work with noTablePartitioning mode', async function () {
    // This test covers the noPartitioning path in plans.ts (lines 244, 260)
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noTablePartitioning: true
    })

    // Basic send/fetch to verify everything works
    const jobId = await ctx.boss.send(ctx.schema, { test: 'noPartitioning' })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()
    expect(job.id).toBe(jobId)

    await ctx.boss.complete(ctx.schema, jobId)

    // Verify job is completed
    const completedJob = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(completedJob)
    expect(completedJob.state).toBe('completed')
  })
})
