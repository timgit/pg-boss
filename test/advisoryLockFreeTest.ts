import { expect, it, describe } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as plans from '../src/plans.ts'

// The advisory-lock-free SQL path - plans.locked() omitting pg_advisory_xact_lock - is taken by
// every backend whose profile sets noAdvisoryLocks (YugabyteDB and CockroachDB). The general suite
// never runs it: standard/distributed Postgres and PGlite all keep advisory locks on, and the real
// CockroachDB CI job bundles noAdvisoryLocks with the distributed fetch path and only runs the
// narrow distributedDatabaseTest. This file pins the lock-free variant directly, exercised on plain
// Postgres via the __test__noAdvisoryLocks hook (the same cheap-toggle trick __test__distributed
// uses for the distributed path) - no Yugabyte/Cockroach container needed. The real-cluster check
// stays manual (npm run test:yugabytedb:full).

describe('advisory-lock-free SQL generation', function () {
  it('omits pg_advisory_xact_lock when noAdvisoryLocks is set, includes it by default', function () {
    const schema = 'pgboss'
    const sql = 'SELECT 1'

    const withLock = plans.locked(schema, sql, 'k')
    expect(withLock).toContain('pg_advisory_xact_lock')

    const lockFree = plans.locked(schema, sql, 'k', true)
    expect(lockFree).not.toContain('pg_advisory_xact_lock')
    // the wrapped statement still runs inside the same transaction, just without the lock
    expect(lockFree).toContain(sql)
  })
})

helper.describePglite('advisory-lock-free runtime path', function () {
  it('runs the queue lifecycle and maintenance with advisory locks disabled', async function () {
    // __test__noAdvisoryLocks forces config.noAdvisoryLocks on plain Postgres, so every locked()
    // call site (schema build on start, createQueue/deleteQueue, queue-stats caching, the supervise
    // maintenance sweep) emits and runs its lock-free transaction variant on a real connection.
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      __test__noAdvisoryLocks: true,
      persistQueueStats: true,
      noDefault: true
    })

    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { deleteAfterSeconds: 0 })

    const jobId = await ctx.boss.send(queue, { hello: 'world' })
    helper.assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(queue)
    expect(job.id).toBe(jobId)
    await ctx.boss.complete(queue, jobId)

    // Drives #monitor (cacheQueueStats + insertQueueStats + failJobsByTimeout) and #maintain
    // (deletion + cleanupDependencies) - the maintenance locked() call sites - lock-free.
    await ctx.boss.supervise(queue)

    const stats = await ctx.boss.getQueueStats(queue)
    expect(Array.isArray(stats)).toBe(true)

    // deleteQueue is the remaining locked() surface
    await ctx.boss.deleteQueue(queue)
    const gone = await ctx.boss.getQueue(queue)
    expect(gone).toBeNull()
  })
})
