import { expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

// This file holds ONLY the invariants the general suite structurally cannot express. General
// behavioral coverage (fetch/complete/fail/retry/policies/flows/dead-letter/...) already runs in
// distributed mode two ways: the whole suite under `DISTRIBUTED=true` on Postgres (fast, every push)
// and under `DB_TYPE=cockroachdb` against a real cluster (`npm run test:cockroachdb:full`), where
// testHelper.getConfig() turns on distributedDatabaseMode for every test. Don't re-test generic
// behavior here — add it to the relevant suite instead. What stays here:
//
//   1. Concurrent-fetch deduplication — the core guarantee of the atomic UPDATE...RETURNING fetch
//      that replaces SKIP LOCKED; no generic test asserts "N concurrent workers, zero duplicates".
//   2. Caller-supplied-transaction composition for completeDistributed/failDistributed — the
//      withDistributedTransaction contract (compose inline, roll back with the caller's tx).
//   3. Flag-gated schema construction (noTablePartitioning / noDeferrableConstraints /
//      noCoveringIndexes / noAdvisoryLocks) — the ONLY Postgres-side coverage of that DDL, since the
//      `DISTRIBUTED=true` job sets distributedDatabaseMode but NOT the no* flags.
//
// Every test here calls helper.start(), which on CockroachDB pays slow per-test DDL (~8-9s observed
// in CI), leaving little headroom under the 10s global timeout. Raise the default for the whole
// block so startup jitter can't push a test over the edge (the concurrency tests keep their explicit
// per-test overrides).
helper.describePglite('distributed database mode', { timeout: 20000 }, function () {
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

  it('should compose failDistributed inside a caller transaction and roll back with it', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    // Send and fetch a job
    const jobId = await ctx.boss.send(ctx.schema, { test: 'rollback' }, { retryLimit: 1 })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()

    // When the caller supplies its own connection, fail() runs its delete + re-insert inline (no
    // BEGIN/COMMIT of its own) so it composes inside the caller's transaction. Aborting that
    // transaction must undo the whole sequence, leaving the job active. (Under the old code, the
    // inner COMMIT would have committed the caller's work early, so the job would stay failed.)
    const _db = await helper.getDb()
    try {
      await expect(
        _db.withTransaction(async txDb => {
          await ctx.boss!.fail(ctx.schema, jobId, null, { db: txDb })
          throw new Error('Simulated caller abort')
        })
      ).rejects.toThrow('Simulated caller abort')

      const jobData = await ctx.boss.getJobById(ctx.schema, jobId)
      helper.assertTruthy(jobData)
      expect(jobData.state).toBe('active')
    } finally {
      await _db.close()
    }
  })

  it('should return 0 affected when failing a non-existent job in distributed mode', async function () {
    // Covers failDistributed's empty-select short-circuit, which the generic suite never hits in
    // distributed mode during the standard (non-distributed) coverage run.
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const result = await ctx.boss.fail(ctx.schema, '00000000-0000-0000-0000-000000000000')
    expect(result.affected).toBe(0)
  })

  it('should fail timed-out jobs to the dead letter queue via distributed supervise', async function () {
    // Exercises the distributed maintenance-expiry path: boss.#monitor ->
    // manager.failJobsByTimeoutDistributed -> expireJobsDistributed -> reinsertFailedJobs (failed +
    // dead-letter branch). retryLimit 0 forces the terminal "failed" re-insert rather than a retry.
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true, monitorIntervalSeconds: 1, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter, retryLimit: 0 })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job.id).toBe(jobId)

    // Backdate started_on so the job is past its expiration window
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${ctx.schema}.job SET started_on = now() - interval '1 hour' WHERE id = $1`, [jobId])
    await db.close()

    await ctx.boss.supervise(ctx.schema)

    const failed = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(failed)
    expect(failed.state).toBe('failed')

    const [dlqJob] = await ctx.boss.fetch<{ key: string }>(deadLetter)
    expect(dlqJob).toBeTruthy()
    expect(dlqJob.data.key).toBe(ctx.schema)
  })

  it('should retry heartbeat-timed-out jobs with backoff via distributed supervise', async function () {
    // Exercises boss.#monitor -> manager.failJobsByHeartbeatDistributed and the retry-with-backoff
    // branch of reinsertFailedJobs (retryBackoff: true), which the failDistributed rollback test
    // above does not reach (it uses the non-backoff retry path).
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true, monitorIntervalSeconds: 1, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 1, retryBackoff: true })

    const jobId = await ctx.boss.send(ctx.schema)
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job.id).toBe(jobId)

    // Backdate heartbeat_on so the heartbeat is considered timed out
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${ctx.schema}.job SET heartbeat_on = now() - interval '60 seconds' WHERE id = $1`, [jobId])
    await db.close()

    await ctx.boss.supervise(ctx.schema)

    const retried = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(retried)
    expect(retried.state).toBe('retry')
  })

  it('should compose completeDistributed inside a caller transaction and roll back with it', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'rollback' })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()

    // complete() with a caller-supplied connection composes inline inside the caller's
    // transaction, so aborting the transaction must leave the job active rather than completed.
    const _db = await helper.getDb()
    try {
      await expect(
        _db.withTransaction(async txDb => {
          await ctx.boss!.complete(ctx.schema, jobId, null, { db: txDb })
          throw new Error('Simulated caller abort')
        })
      ).rejects.toThrow('Simulated caller abort')

      const jobData = await ctx.boss.getJobById(ctx.schema, jobId)
      helper.assertTruthy(jobData)
      expect(jobData.state).toBe('active')
    } finally {
      await _db.close()
    }
  })

  it('should unblock dependents when completing a blocking parent in distributed mode', async function () {
    // completeDistributed splits the dependency-unblock into a second statement
    // (plans.completeJobsDistributed + plans.decrementDependents) to avoid CockroachDB's
    // multi-mutation CTE limit. Completing a blocking parent is the only thing that runs the
    // decrementDependents branch.
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const [parent] = await ctx.boss.fetch(ctx.schema)
    expect(parent.id).toBe(flow.parent)

    await ctx.boss.complete(ctx.schema, parent.id)

    const child = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(child)
    expect(child.blocked).toBe(false)
    expect(child.pendingDependencies).toBe(0)
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
