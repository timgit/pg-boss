import { it, expect } from './harness.ts'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

// This file holds ONLY the invariants the general suite structurally cannot express. General
// behavioral coverage (fetch/complete/fail/retry/policies/flows/dead-letter/...) already runs in
// the no-SKIP-LOCKED path via the whole suite under `NO_SKIP_LOCKED_NO_CTE=true` on Postgres, where
// testHelper.getConfig() turns on noSkipLocked + noMultiMutationCte for every test. Don't re-test
// generic behavior here — add it to the relevant suite instead. What stays here:
//
//   1. Concurrent-fetch deduplication — the core guarantee of the atomic UPDATE...RETURNING fetch
//      that replaces SKIP LOCKED; no generic test asserts "N concurrent workers, zero duplicates".
//   2. Caller-supplied-transaction composition for completeNoCte/failNoCte — the
//      ensureTransaction contract (compose inline, roll back with the caller's tx).
//   3. Flag-gated schema construction (noTablePartitioning / noDeferrableConstraints /
//      noCoveringIndexes / noAdvisoryLocks) — the ONLY Postgres-side coverage of that DDL, since the
//      `NO_SKIP_LOCKED_NO_CTE=true` job sets noSkipLocked + noMultiMutationCte but NOT the schema no* flags.
//      These now select the flags through the __test__ hooks (the backend profiles are gone).
//
// The concurrency tests need more than the runner default on Postgres, so they carry their own override.
const concurrencyTimeout = 30000

helper.describePglite('no-SKIP-LOCKED / no-CTE mode', function () {
  it('should not duplicate jobs when fetching concurrently with SKIP LOCKED disabled', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })
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
    // This is the key guarantee of the no-SKIP-LOCKED path
    const jobIds = allJobs.map(j => j.id)
    const uniqueJobIds = new Set(jobIds)
    expect(uniqueJobIds.size).toBe(jobIds.length)

    // Due to concurrent contention, not all jobs may be claimed in one round
    // but no job should be duplicated
    expect(allJobs.length).toBeLessThanOrEqual(jobCount)
    expect(allJobs.length).toBeGreaterThan(0)
  }, concurrencyTimeout)

  it('should handle high concurrency without duplicates with SKIP LOCKED disabled', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })
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
  }, concurrencyTimeout)

  it('should compose failNoCte inside a caller transaction and roll back with it', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })

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

  it('should return 0 affected when failing a non-existent job with SKIP LOCKED disabled', async function () {
    // Covers failNoCte's empty-select short-circuit, which the generic suite never hits in
    // the no-SKIP-LOCKED path during the standard (single-statement) coverage run.
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })

    const result = await ctx.boss.fail(ctx.schema, '00000000-0000-0000-0000-000000000000')
    expect(result.affected).toBe(0)
  })

  it('should fail timed-out jobs to the dead letter queue via the split supervise path', async function () {
    // Exercises the noMultiMutationCte maintenance-expiry path: boss.#monitor ->
    // manager.failJobsByTimeoutNoCte -> expireJobsNoCte -> reinsertFailedJobs (failed +
    // dead-letter branch). retryLimit 0 forces the terminal "failed" re-insert rather than a retry.
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, monitorIntervalSeconds: 1, noDefault: true })

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

    const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
    expect(dlqJob).toBeTruthy()
    expect(dlqJob.data.key).toBe(ctx.schema)

    // the split insertDeadLetterJob carries source provenance
    const dlqMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
    helper.assertTruthy(dlqMeta)
    expect(dlqMeta.sourceName).toBe(ctx.schema)
    expect(dlqMeta.sourceId).toBe(jobId)
    expect(dlqMeta.sourceCreatedOn).toBeTruthy()
  })

  it('should retry heartbeat-timed-out jobs with backoff via the split supervise path', async function () {
    // Exercises boss.#monitor -> manager.failJobsByHeartbeatNoCte and the retry-with-backoff
    // branch of reinsertFailedJobs (retryBackoff: true), which the failNoCte rollback test
    // above does not reach (it uses the non-backoff retry path).
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, monitorIntervalSeconds: 1, noDefault: true })

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

  it('should retry, not fail, when the backend returns integer columns as strings', async function () {
    // Regression: reinsertFailedJobs read the raw SELECT * rows from the split fail path. With a
    // driver that returns integer columns as strings, `retry_count < retry_limit` was a
    // lexicographic compare — "9" < "10" is false — which permanently failed a job that still had
    // retries left. The NO_SKIP_LOCKED_NO_CTE=true Postgres run can't catch this (node-pg returns numbers
    // there), so we simulate a string-typed driver with a wrapper over a real connection.
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'stringints' }, { retryLimit: 10 })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job.id).toBe(jobId)

    const _db = await helper.getDb()
    try {
      // Put the job one retry short of its limit. Numerically 9 < 10, so it must still retry; only a
      // string comparison ("9" < "10" === false) would wrongly fail it.
      await _db.executeSql(`UPDATE ${ctx.schema}.job SET retry_count = 9 WHERE id = $1`, [jobId])

      // Wrap the connection so SELECT * rows return integer columns as strings, as some drivers
      // do. The fail path's select is the only SELECT * it issues.
      const integerColumns = ['priority', 'retry_limit', 'retry_count', 'retry_delay', 'retry_delay_max', 'group_tier', 'expire_seconds', 'deletion_seconds', 'pending_dependencies']
      const stringIntegerDriver = {
        executeSql: async (text: string, values?: unknown[]) => {
          const result = await _db.executeSql(text, values)
          if (/^\s*SELECT \* FROM/i.test(text)) {
            for (const row of result.rows) {
              for (const col of integerColumns) {
                if (row[col] !== null && row[col] !== undefined) row[col] = String(row[col])
              }
            }
          }
          return result
        }
      }

      await ctx.boss.fail(ctx.schema, jobId, null, { db: stringIntegerDriver })

      const retried = await ctx.boss.getJobById(ctx.schema, jobId)
      helper.assertTruthy(retried)
      expect(retried.state).toBe('retry')
    } finally {
      await _db.close()
    }
  })

  it('should compose completeNoCte inside a caller transaction and roll back with it', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })

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

  it('should unblock dependents when completing a blocking parent with SKIP LOCKED disabled', async function () {
    // Completion no longer unblocks dependents inline (that work moved off the hot path to the
    // background resolver — see issue #824). resolveFlow() forces a resolution pass, which on a
    // noMultiMutationCte backend runs the split selectBlockingParents + decrementDependents + clearBlocking.
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const [parent] = await ctx.boss.fetch(ctx.schema)
    expect(parent.id).toBe(flow.parent)

    await ctx.boss.complete(ctx.schema, parent.id)
    await ctx.boss.resolveFlow()

    const child = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(child)
    expect(child.blocked).toBe(false)
    expect(child.pendingDependencies).toBe(0)
  })

  it('split flow resolver is a no-op when there are no blocking parents', async function () {
    // A completed but non-blocking job has no dependents, so the split flow resolver's batch query
    // (selectBlockingParents) returns nothing and resolveFlowJobsNoCte short-circuits to 0.
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })

    const id = await ctx.boss.send(ctx.schema)
    helper.assertTruthy(id)
    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    // Resolves across the existing queue, finds no completed blocking parents, and does nothing.
    await ctx.boss.resolveFlow()

    const completed = await ctx.boss.getJobById(ctx.schema, id)
    helper.assertTruthy(completed)
    expect(completed.state).toBe('completed')
  })

  helper.itPostgresOnly('should construct schema with all compatibility flags forced on', async function () {
    // Exercises every no*-flag construction branch (no partitioning, non-deferrable constraints,
    // non-covering indexes, no advisory locks, no LISTEN/NOTIFY) plus the no-SKIP-LOCKED + no-CTE runtime path,
    // all forced through the __test__ hooks so the full flag combination constructs and runs on a
    // plain Postgres instance. The flags are not settable directly — resolveBackend() derives them —
    // so the hooks are the only way in.
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      __test__noSkipLockedNoCte: true,
      __test__noAdvisoryLocks: true,
      __test__noTablePartitioning: true,
      __test__noDeferrableConstraints: true,
      __test__noCoveringIndexes: true,
      __test__noListenNotify: true
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

  it('should return numeric stats counts with SKIP LOCKED disabled', async function () {
    // getQueueStats serves counts from a raw stats query rather than the normalized getQueues path;
    // assert the public counts come back as numbers under the no-SKIP-LOCKED + no-CTE runtime path.
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'stats' })
    helper.assertTruthy(jobId)

    const [stats] = await ctx.boss.getQueueStats(ctx.schema)
    expect(typeof stats.queuedCount).toBe('number')
    expect(stats.totalCount).toBe(1)
  })

  helper.itPostgresOnly('should construct schema with no partitioning and no advisory locks', async function () {
    // Exercises the noTablePartitioning + noAdvisoryLocks construction path on plain Postgres.
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      __test__noTablePartitioning: true,
      __test__noAdvisoryLocks: true
    })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'noPartitioning' })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()
    expect(job.id).toBe(jobId)

    await ctx.boss.complete(ctx.schema, jobId)

    const completedJob = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(completedJob)
    expect(completedJob.state).toBe('completed')
  })
})
