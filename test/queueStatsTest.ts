import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import { randomUUID } from 'node:crypto'
import type { ConstructorOptions } from '../src/types.ts'
import { ctx } from './hooks.ts'
import pg from 'pg'

describe('queueStats', function () {
  const queue1 = `q${randomUUID().replaceAll('-', '')}`
  const queue2 = `q${randomUUID().replaceAll('-', '')}`

  async function init (config: (ConstructorOptions & { schema: string }) | (Partial<ConstructorOptions> & { testKey?: string; noDefault?: boolean }) | undefined) {
    const boss = await helper.start(config)

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    await boss.send(queue1)
    await boss.send(queue1)
    await boss.send(queue2)
    await boss.send(queue2)

    return boss
  }

  it('should get accurate stats', async function () {
    ctx.boss = await init(ctx.bossConfig)
    const [queueData] = await ctx.boss.getQueueStats(queue1)
    expect(queueData).not.toBe(undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      readyCount,
      activeCount,
      failedCount,
      totalCount
    } = queueData

    expect(name).toBe(queue1)
    expect(deferredCount).toBe(0)
    expect(queuedCount).toBe(2)
    expect(readyCount).toBe(2)
    expect(activeCount).toBe(0)
    expect(failedCount).toBe(0)
    expect(totalCount).toBe(2)
  })

  it('should exclude deferred jobs from readyCount', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = randomUUID()
    await ctx.boss.createQueue(queue)

    await ctx.boss.send(queue)
    await ctx.boss.send(queue, {}, { startAfter: 100 })

    const [queueData] = await ctx.boss.getQueueStats(queue)

    expect(queueData.queuedCount).toBe(2)
    expect(queueData.deferredCount).toBe(1)
    // readyCount is the true backlog: queued minus the deferred (future-dated) job
    expect(queueData.readyCount).toBe(1)
  })

  it('should not let a cancelled deferred job deflate readyCount', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = randomUUID()
    await ctx.boss.createQueue(queue)

    // two ready jobs plus one deferred job that we then cancel
    await ctx.boss.send(queue)
    await ctx.boss.send(queue)
    const deferredId = await ctx.boss.send(queue, {}, { startAfter: 3600 })
    helper.assertTruthy(deferredId)
    await ctx.boss.cancel(queue, deferredId)

    const [queueData] = await ctx.boss.getQueueStats(queue)

    // deferredCount must be scoped to queued state; the cancelled deferred job (still future-dated)
    // must not be counted, or readyCount (queued - deferred) under-reports the true backlog.
    expect(queueData.queuedCount).toBe(2)
    expect(queueData.deferredCount).toBe(0)
    expect(queueData.readyCount).toBe(2)
  })

  it('should count failed jobs in failedCount', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = randomUUID()
    // retryLimit 0 so a single fail moves the job straight to the failed state
    await ctx.boss.createQueue(queue, { retryLimit: 0 })

    await ctx.boss.send(queue)
    const [job] = await ctx.boss.fetch(queue)
    await ctx.boss.fail(queue, job.id)

    const [queueData] = await ctx.boss.getQueueStats(queue)

    expect(queueData.failedCount).toBe(1)
    expect(queueData.queuedCount).toBe(0)
    expect(queueData.readyCount).toBe(0)
    expect(queueData.totalCount).toBe(1)
  })

  // Skipped on PGlite, whose adapter does not route through pg-types.
  helper.describeMultiConnectionOnly('with a custom timestamptz parser on the pool', function () {
    it('serves the cache without coercing capturedOn to a Date', async function () {
      // Applications sharing their pool with pg-boss may parse timestamptz into a type whose
      // valueOf throws (Temporal.Instant). Internal age arithmetic must not depend on new Date().
      const types = new pg.TypeOverrides()
      types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (raw: string) => ({
        raw,
        valueOf () { throw new TypeError('Do not use valueOf on this timestamp') }
      }))

      // Not a declared pg-boss option, but forwarded to pg.Pool like any other connection setting.
      ctx.boss = await init({ ...ctx.bossConfig, types } as ConstructorOptions & { schema: string })

      // First read finds no capture and refreshes. The second reads the capture back and ages it.
      await ctx.boss.getQueueStats(queue1)
      const [queueData] = await ctx.boss.getQueueStats(queue1)

      expect(queueData.totalCount).toBe(2)
    })
  })

  it('should get accurate stats on an empty queue', async function () {
    ctx.boss = await init(ctx.bossConfig)
    const queue3 = randomUUID()
    await ctx.boss.createQueue(queue3)

    const [queueData] = await ctx.boss.getQueueStats(queue3)
    expect(queueData).not.toBe(undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      activeCount,
      totalCount
    } = queueData

    expect(name).toBe(queue3)
    expect(deferredCount).toBe(0)
    expect(queuedCount).toBe(0)
    expect(activeCount).toBe(0)
    expect(totalCount).toBe(0)
  })

  it('should properly get queue stats when all jobs are deleted', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const queue4 = randomUUID()
    await ctx.boss.createQueue(queue4)

    await ctx.boss.send(queue4)
    await ctx.boss.send(queue4)
    await ctx.boss.send(queue4)

    await ctx.boss.deleteAllJobs(queue4)

    // never monitored, so getQueueStats recomputes from the job table and reflects the deletion
    const [queueData] = await ctx.boss.getQueueStats(queue4)
    expect(queueData).toBeTruthy()

    expect(queueData.deferredCount).toBe(0)
    expect(queueData.queuedCount).toBe(0)
    expect(queueData.activeCount).toBe(0)
    expect(queueData.totalCount).toBe(0)
  })

  /**
   * Throughput, which is the one thing the other counts cannot answer: five
   * hundred jobs arriving and five hundred leaving looks identical to a still
   * queue in every gauge on this table.
   */
  describe('completedDelta and failedDelta', function () {
    /**
     * One monitor pass, run the way the monitor runs it.
     *
     * Not `getQueueStats({ force: true })`: that reuses anything computed in the
     * last minute, so two passes in one test would read back the row the first
     * one wrote. And not by winding `monitor_on` backwards either — that is the
     * watermark these counters are windowed on, so moving it is moving the
     * thing under test.
     */
    async function monitorPass (queue: string, throughput = true) {
      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      const { rows: [{ table_name: table }] } = await db.executeSql(
        `SELECT table_name FROM ${schema}.queue WHERE name = $1`, [queue]
      )

      const { rows } = await db.executeSql(
        plans.refreshQueueStats(schema, table, queue, { noAdvisoryLocks: true, throughput }), []
      )

      return rows[0]
    }

    /**
     * The counters cost a join and three filters on the monitor's biggest
     * query, so they are counted only with persistQueueStats. Without it the
     * aggregate must be the one that shipped before throughput existed, and the
     * columns stay at zero.
     */
    it('counts nothing when tracking is off', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await ctx.boss.send(queue)
      await monitorPass(queue, false)

      const [job] = await ctx.boss.fetch(queue)
      await ctx.boss.complete(queue, job.id)

      const off = await monitorPass(queue, false)
      expect(off.completedDelta).toBe(0)
      expect(off.createdDelta).toBe(0)
    })

    /**
     * Turning it on starts the series; it does not recover the past.
     *
     * The window is the watermark, and passes made while tracking was off moved
     * the watermark like any other pass. So work done before the switch is
     * behind it and stays uncounted — which is worth knowing, because a chart
     * that began yesterday should say so rather than imply the queue was idle.
     */
    it('starts counting when it is turned on, and does not backfill', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await ctx.boss.send(queue)

      const [before] = await ctx.boss.fetch(queue)
      await ctx.boss.complete(queue, before.id)

      // An untracked pass still advances the watermark, so this completion ends
      // up behind it — counted by nobody, which is the cost of having had the
      // option off when it happened.
      await monitorPass(queue, false)

      expect((await monitorPass(queue, true)).completedDelta).toBe(0)

      await ctx.boss.send(queue)
      const [after] = await ctx.boss.fetch(queue)
      await ctx.boss.complete(queue, after.id)

      expect((await monitorPass(queue, true)).completedDelta).toBe(1)
    })

    it('counts arrivals, which is the other half of a growing backlog', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue)

      await ctx.boss.send(queue)
      await ctx.boss.send(queue)

      const after = await monitorPass(queue)
      expect(after.createdDelta).toBe(2)
      expect(after.completedDelta).toBe(0)
    })

    it('counts what finished between one pass and the next', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      // First pass: establishes the watermark. Nothing has finished yet, and a
      // queue with no previous pass to compare against must count zero rather
      // than everything in the table.
      await ctx.boss.send(queue)
      const before = await monitorPass(queue)
      expect(before.completedDelta).toBe(0)

      const [job] = await ctx.boss.fetch(queue)
      await ctx.boss.complete(queue, job.id)

      const after = await monitorPass(queue)
      expect(after.completedDelta).toBe(1)
      expect(after.failedDelta).toBe(0)
    })

    /** The window moves with the watermark, so nothing is counted twice. */
    it('does not count the same job in two passes', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await ctx.boss.send(queue)
      await monitorPass(queue)

      const [job] = await ctx.boss.fetch(queue)
      await ctx.boss.complete(queue, job.id)

      expect((await monitorPass(queue)).completedDelta).toBe(1)
      // The window now starts after that completion, so the same row is behind
      // the watermark and is never counted again.
      expect((await monitorPass(queue)).completedDelta).toBe(0)
    })

    it('counts a terminal failure, and not a retry', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const retried = randomUUID()
      const terminal = randomUUID()

      await ctx.boss.createQueue(retried, { retryLimit: 1 })
      await ctx.boss.createQueue(terminal, { retryLimit: 0 })

      await ctx.boss.send(retried)
      await ctx.boss.send(terminal)
      await monitorPass(retried)
      await monitorPass(terminal)

      const [retryJob] = await ctx.boss.fetch(retried)
      await ctx.boss.fail(retried, retryJob.id)

      const [failJob] = await ctx.boss.fetch(terminal)
      await ctx.boss.fail(terminal, failJob.id)

      // A job that will be retried has not finished, whatever its timestamps say.
      expect((await monitorPass(retried)).failedDelta).toBe(0)
      expect((await monitorPass(terminal)).failedDelta).toBe(1)
    })

    /**
     * The option is persistQueueStats, not a flag of its own: a per-pass count
     * is only worth anything once it is kept. So the whole path — monitor,
     * cache, snapshot, history read — has to carry them when it is on.
     */
    it('records throughput in the history when persistQueueStats is on', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true, monitorIntervalSeconds: 1 })
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      // The first pass sets the watermark; the second counts what came after it.
      await ctx.boss.supervise(queue)
      await ctx.boss.send(queue)
      await ctx.boss.send(queue)

      await expect.poll(async () => {
        await ctx.boss!.supervise(queue)
        const series = await ctx.boss!.getQueueStats(queue)
        return series.reduce((sum, row) => sum + (row.createdDelta ?? 0), 0)
      }, { timeout: 10_000, interval: 500 }).toBe(2)
    })

    /** Nobody counted, so the answer is null — zero would say the queue was idle. */
    it('reports null throughput when persistQueueStats is off', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: false })
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await ctx.boss.send(queue)
      const [stats] = await ctx.boss.getQueueStats(queue, { force: true })

      expect(stats.queuedCount).toBe(1)
      expect(stats.completedDelta).toBe(null)
      expect(stats.failedDelta).toBe(null)
      expect(stats.createdDelta).toBe(null)
    })

    /**
     * A snapshot recorded before the counting existed has no value. The
     * migration leaves the columns null for exactly this row, and the history
     * read has to hand that on rather than default it to zero.
     */
    it('reports null throughput on a snapshot captured before it was counted', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      await db.executeSql(
        `INSERT INTO ${schema}.queue_stats (name, ready_count, captured_on) VALUES ($1, 3, now() - interval '1 hour')`,
        [queue]
      )

      const [old] = await ctx.boss.getQueueStats(queue)
      expect(old.readyCount).toBe(3)
      expect(old.completedDelta).toBe(null)
      expect(old.createdDelta).toBe(null)

      const [bucket] = await ctx.boss.getQueueStats(queue, { bucketSeconds: 3600 })
      expect(bucket.completedDelta).toBe(null)
    })

    it('counts every job in a batch', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      for (let i = 0; i < 5; i++) {
        await ctx.boss.send(queue)
      }
      await monitorPass(queue)

      const jobs = await ctx.boss.fetch(queue, { batchSize: 5 })
      await ctx.boss.complete(queue, jobs.map(job => job.id))

      expect((await monitorPass(queue)).completedDelta).toBe(5)
    })
  })
})
