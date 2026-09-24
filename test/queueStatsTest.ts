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
     * One monitor pass, run the way the monitor runs it: the monitor's own
     * statement, then the counts it left on the queue row.
     *
     * Not `getQueueStats({ force: true })`: that reuses anything computed in the
     * last minute, and a forced refresh never counts throughput. And not by
     * winding `delta_on` backwards either, except where a test is about the
     * window itself — that is the watermark these counters are windowed on.
     *
     * The window ends at job_now() unless `fromOpenTransactions` is set. Test
     * files run side by side on one database, and another file's open write
     * transaction would hold that end back and push a count into the next pass.
     *
     * The window's lag is zero here unless a test passes the real one: the
     * production lag is a minute, and these tests are about what a window
     * counts, not about waiting for it. The tests on the lag itself age the
     * stamps instead.
     */
    async function monitorPass (queue: string, throughput = true, fromOpenTransactions = false, window: plans.DeltaWindowOptions = { lag: "interval '0'" }) {
      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      const { rows: [{ table_name: table }] } = await db.executeSql(
        `SELECT table_name FROM ${schema}.queue WHERE name = $1`, [queue]
      )

      await db.executeSql(plans.cacheQueueStats(schema, table, [queue], true, throughput, fromOpenTransactions, window))
      const { rows } = await db.executeSql(plans.getQueueStatsCache(schema), [queue])

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
     * A queue that has never been counted has no window, so the first counted
     * pass opens one and counts nothing. Work done before the switch stays
     * uncounted, which is worth knowing, because a chart that began yesterday
     * should say so rather than imply the queue was idle.
     */
    it('starts counting when it is turned on, and does not backfill', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await ctx.boss.send(queue)

      const [before] = await ctx.boss.fetch(queue)
      await ctx.boss.complete(queue, before.id)

      // An untracked pass opens no window, so the first tracked pass has nothing
      // to count from and this completion is counted by nobody, which is the
      // cost of having had the option off when it happened.
      await monitorPass(queue, false)

      const first = await monitorPass(queue, true)
      expect(first.completedDelta).toBe(0)
      expect(first.deltaSeconds).toBe(null)

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
      // The real monitor runs here, with the real lag: the sends are a minute
      // too young to count until they are aged past it.
      await age(queue, '2 minutes')
      await windBack(queue, '3 minutes')

      await expect.poll(async () => {
        await ctx.boss!.supervise(queue)
        const series = await ctx.boss!.getQueueStats(queue)
        return series.reduce((sum, row) => sum + (row.createdDelta ?? 0), 0)
      }, { timeout: 10_000, interval: 500 }).toBe(2)

      // Each snapshot says when the interval its counters cover ended, which
      // trails the pass by the lag.
      const [newest] = await ctx.boss.getQueueStats(queue)
      expect(newest.deltaOn).toBeInstanceOf(Date)
      expect(newest.capturedOn.getTime() - newest.deltaOn!.getTime()).toBeGreaterThanOrEqual(60_000)
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

    /** Moves this queue's counting window back, which is the only way to give a fast test real seconds. */
    async function windBack (queue: string, interval: string) {
      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      await db.executeSql(
        `UPDATE ${schema}.queue SET delta_on = ${schema}.job_now() - interval '${interval}' WHERE name = $1`, [queue]
      )
    }

    /** Ages this queue's jobs, so a stamp lands before a window end that trails the pass. */
    async function age (queue: string, interval: string) {
      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      await db.executeSql(
        `UPDATE ${schema}.job
         SET created_on = created_on - interval '${interval}', completed_on = completed_on - interval '${interval}'
         WHERE name = $1`, [queue]
      )
    }

    /**
     * The window ends a minute behind the pass, not at it. A job's stamp is the
     * start of the transaction that wrote it, and the row is only visible once
     * that transaction commits, so a window ending at the pass stepped past any
     * stamp still in flight. Trailing by a minute, a transaction that commits
     * within a minute of starting is counted whatever role it runs as, and on
     * every backend. The cost is that a job just finished waits a pass or two
     * to be counted.
     */
    it('ends the window a minute behind the pass', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue, true, false, {})
      await ctx.boss.send(queue)

      // Just sent, so still inside the lag: not counted, and the window's end
      // says so.
      const young = await monitorPass(queue, true, false, {})
      expect(young.createdDelta).toBe(0)
      expect(young.capturedOn.getTime() - young.deltaOn.getTime()).toBeGreaterThanOrEqual(60_000)
      expect(young.capturedOn.getTime() - young.deltaOn.getTime()).toBeLessThan(65_000)

      // Once the stamp is older than the lag, the next window covers it.
      await age(queue, '90 seconds')
      await windBack(queue, '3 minutes')
      expect((await monitorPass(queue, true, false, {})).createdDelta).toBe(1)
    })

    /**
     * Counters describe the minute before the gauges next to them, so bucketing
     * both by capture time would set every counter a bucket late. Gauges are
     * bucketed by capturedOn and counters by deltaOn, joined per bucket, and the
     * newest bucket has no counters until the pass that counts its minute runs.
     */
    it('buckets the counters by the interval they cover, beside the gauges of that minute', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      // Far enough back that nothing the running monitor writes can land in the range.
      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000
      const minute = (n: number) => new Date(hour - n * 60_000)
      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      await db.executeSql(
        `INSERT INTO ${schema}.queue_stats (name, ready_count, completed_delta, delta_seconds, delta_on, captured_on)
         VALUES ($1, 5, 0, 60, $2, $3), ($1, 7, 4, 60, $4, $5)`,
        [queue, minute(31), minute(30), minute(30), minute(29)]
      )

      const buckets = await ctx.boss.getQueueStats(queue, { bucketSeconds: 60, from: minute(30), to: minute(25) })
      expect(buckets.map(b => b.capturedOn.getTime())).toEqual([minute(29).getTime(), minute(30).getTime()])

      // The row captured at minute 29 carries the gauges of that minute and the
      // counters of the minute before it, which sit beside that minute's gauges.
      const [newest, aligned] = buckets
      expect(newest.readyCount).toBe(7)
      expect(newest.completedDelta).toBe(null)
      expect(newest.deltaOn).toBe(null)
      expect(aligned.readyCount).toBe(5)
      expect(aligned.completedDelta).toBe(4)
      expect(aligned.deltaSeconds).toBe(60)
      expect(aligned.deltaOn!.getTime()).toBe(minute(30).getTime())
    })

    /**
     * Passes are not evenly spaced. One the vacuum backoff deferred covers
     * several intervals, and dividing its counts by the bucket width would chart
     * a spike. deltaSeconds is the real span, so a rate is exact either way.
     */
    it('records how many seconds the counts cover', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue)
      await ctx.boss.send(queue)
      await windBack(queue, '90 seconds')

      const pass = await monitorPass(queue)
      expect(pass.createdDelta).toBe(1)
      expect(pass.deltaSeconds).toBeGreaterThanOrEqual(90)
      expect(pass.deltaSeconds).toBeLessThan(95)
    })

    /** Zero arrivals over a minute is a rate of zero, not a missing reading. */
    it('records the span for an idle queue, which has no job rows to aggregate', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue)
      await windBack(queue, '60 seconds')

      const pass = await monitorPass(queue)
      expect(pass.createdDelta).toBe(0)
      expect(pass.deltaSeconds).toBeGreaterThanOrEqual(60)
    })

    /**
     * A pass that doesn't count still writes the queue row: an instance with
     * persistQueueStats off, or a forced getQueueStats refresh. Windowing on the
     * monitor timestamp let each of those swallow the jobs before it. The window
     * is only moved by a pass that counts, so the next one picks them up.
     */
    it('keeps counting across a pass that does not count', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue)
      await ctx.boss.send(queue)
      const [job] = await ctx.boss.fetch(queue)
      await ctx.boss.complete(queue, job.id)

      await monitorPass(queue, false)

      const pass = await monitorPass(queue)
      expect(pass.createdDelta).toBe(1)
      expect(pass.completedDelta).toBe(1)
    })

    /**
     * Counting switched off and back on hours later would otherwise report the
     * whole gap on one snapshot, a spike at the moment it was turned back on.
     */
    it('starts a fresh window when the last count is over an hour old', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue)
      await ctx.boss.send(queue)
      await windBack(queue, '2 hours')

      const stale = await monitorPass(queue)
      expect(stale.createdDelta).toBe(0)
      expect(stale.deltaSeconds).toBe(null)

      await ctx.boss.send(queue)
      expect((await monitorPass(queue)).createdDelta).toBe(1)
    })

    /** The rollup plan depends on this: seconds sum across a bucket like the counts do. */
    it('carries deltaSeconds through the history, summed per bucket', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      // Two rows in the hour before this one, read with `to` bounding it, so a
      // snapshot the running monitor writes meanwhile can't be the newest row.
      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000
      const to = new Date(hour - 1)
      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      await db.executeSql(
        `INSERT INTO ${schema}.queue_stats (name, completed_delta, delta_seconds, delta_on, captured_on)
         VALUES ($1, 4, 60, $2::timestamptz - interval '60 seconds', $2), ($1, 6, 150, $3::timestamptz - interval '60 seconds', $3)`,
        [queue, new Date(hour - 50 * 60_000), new Date(hour - 40 * 60_000)]
      )

      const [newest] = await ctx.boss.getQueueStats(queue, { to })
      expect(newest.deltaSeconds).toBe(150)

      const [bucket] = await ctx.boss.getQueueStats(queue, { bucketSeconds: 3600, to })
      expect(bucket.completedDelta).toBe(10)
      expect(bucket.deltaSeconds).toBe(210)
    })

    /** QueueResult has always declared the counters; getQueue has to return them. */
    it('returns the counters from getQueue', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue)
      await ctx.boss.send(queue)
      await windBack(queue, '30 seconds')
      await monitorPass(queue)

      const result = await ctx.boss.getQueue(queue)
      expect(result!.createdDelta).toBe(1)
      expect(result!.completedDelta).toBe(0)
      expect(result!.deltaSeconds).toBeGreaterThanOrEqual(30)
    })

    /**
     * created_on and completed_on are the start of the transaction that wrote
     * them. A transactional worker's completion commits after its handler, and a
     * window ending at now() stepped past its stamp while the row was still
     * invisible, so no pass ever counted it. The window now ends at the oldest
     * open write transaction, which holds it back until this one commits.
     */
    // A second connection holds the transaction open, which pglite doesn't have. CockroachDB and
    // YugabyteDB end the window at the pass instead, so a late commit there is still missed.
    it.skipIf(helper.isPglite || helper.isCockroachDb || helper.isYugabyteDb)('counts a completion committed after a pass, from a transaction that began before it', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue, true, true)
      await ctx.boss.send(queue)
      const [job] = await ctx.boss.fetch(queue)

      const tx = new pg.Client({ connectionString: helper.getConnectionString() })
      await tx.connect()

      try {
        await tx.query('BEGIN')
        await ctx.boss.complete(queue, job.id, null, {
          db: { executeSql: (text: string, values?: unknown[]) => tx.query(text, values as any[]) }
        })

        // A pass while it is still open cannot see the completion, and must not
        // step past its stamp.
        await new Promise(resolve => setTimeout(resolve, 50))
        let counted = (await monitorPass(queue, true, true)).completedDelta

        await tx.query('COMMIT')

        // Other test files' transactions can hold the window back a pass, so
        // keep passing until it is counted. Lost, it never would be.
        await expect.poll(async () => {
          counted += (await monitorPass(queue, true, true)).completedDelta
          return counted
        }, { timeout: 5_000, interval: 200 }).toBe(1)
      } finally {
        await tx.end()
      }
    })

    /**
     * Only transactions that had written were held for, and a transaction that
     * had only read when the pass ran could still complete a job before it
     * committed, stamped with its start, which the pass had already stepped past.
     */
    it.skipIf(helper.isPglite || helper.isCockroachDb || helper.isYugabyteDb)('counts a completion from a transaction that had only read when the pass ran', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await monitorPass(queue, true, true)
      await ctx.boss.send(queue)
      const [job] = await ctx.boss.fetch(queue)

      const tx = new pg.Client({ connectionString: helper.getConnectionString() })
      await tx.connect()

      try {
        await tx.query('BEGIN')
        await tx.query('SELECT 1')

        // Nothing written yet, and the pass must still not step past this transaction's start.
        await new Promise(resolve => setTimeout(resolve, 50))
        let counted = (await monitorPass(queue, true, true)).completedDelta

        await ctx.boss.complete(queue, job.id, null, {
          db: { executeSql: (text: string, values?: unknown[]) => tx.query(text, values as any[]) }
        })
        await tx.query('COMMIT')

        await expect.poll(async () => {
          counted += (await monitorPass(queue, true, true)).completedDelta
          return counted
        }, { timeout: 5_000, interval: 200 }).toBe(1)
      } finally {
        await tx.end()
      }
    })

    /**
     * An open transaction holds the window's end back, but never further than
     * the window's own maximum. Past that the end used to jump to now, which put
     * the window's start out of range and reset it: one transaction left open
     * for an hour dropped that hour's counts for every queue. Now the end sits
     * at the cap and walks forward with the clock until the transaction ends.
     *
     * Tested at the statement, with the cap shortened: a test cannot hold a
     * transaction open for an hour.
     */
    it.skipIf(helper.isPglite || helper.isCockroachDb || helper.isYugabyteDb)('caps how far an open transaction holds the window end back', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const schema = ctx.bossConfig.schema

      const holder = new pg.Client({ connectionString: helper.getConnectionString() })
      const reader = new pg.Client({ connectionString: helper.getConnectionString() })
      await holder.connect()
      await reader.connect()

      const windowEnd = async (holdBackMax?: string) => {
        await reader.query('BEGIN')
        await reader.query(plans.setDeltaWindowEnd(schema, { lag: "interval '0'", holdBackMax }))
        const { rows: [row] } = await reader.query(
          `SELECT current_setting('${plans.DELTA_WINDOW_END_SETTING}')::timestamptz AS "end", now() AS at`
        )
        await reader.query('COMMIT')
        return row as { end: Date, at: Date }
      }

      try {
        await holder.query('BEGIN')
        // Read-only, and still counted as open.
        const { rows: [{ started }] } = await holder.query('SELECT now() AS started')
        await new Promise(resolve => setTimeout(resolve, 1_500))

        // Within the cap, the end is the transaction's start (or an older one another test holds).
        const held = await windowEnd()
        expect(held.end.getTime()).toBeLessThanOrEqual(started.getTime())

        // Past the cap, the end is the cap behind now: not the transaction's start, and not now.
        const capped = await windowEnd("interval '1 second'")
        expect(capped.end.getTime()).toBeGreaterThan(started.getTime())
        expect(capped.at.getTime() - capped.end.getTime()).toBe(1_000)
      } finally {
        await holder.end()
        await reader.end()
      }
    })

    /**
     * A counter's bucket can hold no capture: passes drift, so a pass time
     * minus the lag lands a bucket away from the previous capture, and a
     * held-back deltaOn lands wherever its transaction started. Returned on
     * its own, that bucket's gauges would read as zero and chart the queue as
     * empty. It is folded into the newest gauge bucket at or before it instead,
     * or the first in range when none precedes it.
     */
    it('folds a counter whose bucket has no capture into the capture before it', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000
      const minute = (n: number) => new Date(hour - n * 60_000)
      const db = await helper.getDb()
      const schema = ctx.bossConfig.schema
      // Captures at minutes 31 and 29; the second one's counters cover an
      // interval ending in minute 30, where nothing was captured.
      await db.executeSql(
        `INSERT INTO ${schema}.queue_stats (name, ready_count, completed_delta, delta_seconds, delta_on, captured_on)
         VALUES ($1, 5, NULL, NULL, NULL, $2), ($1, 7, 4, 60, $3, $4)`,
        [queue, minute(31), minute(30), minute(29)]
      )

      const buckets = await ctx.boss.getQueueStats(queue, { bucketSeconds: 60, from: minute(32), to: minute(25) })
      expect(buckets.map(b => b.capturedOn.getTime())).toEqual([minute(29).getTime(), minute(31).getTime()])
      const [newest, folded] = buckets
      expect(newest.readyCount).toBe(7)
      expect(newest.completedDelta).toBe(null)
      expect(folded.readyCount).toBe(5)
      expect(folded.completedDelta).toBe(4)
      expect(folded.deltaOn!.getTime()).toBe(minute(30).getTime())

      // With no capture before it in range, it joins the first one after.
      const [only] = await ctx.boss.getQueueStats(queue, { bucketSeconds: 60, from: minute(30), to: minute(25) })
      expect(only.capturedOn.getTime()).toBe(minute(29).getTime())
      expect(only.readyCount).toBe(7)
      expect(only.completedDelta).toBe(4)
    })

    /**
     * The window a transaction held back has to survive the transaction ending.
     * While it is open past the cap, each pass ends its window the cap behind
     * itself and starts the next one there. When it commits, the next pass's
     * end springs forward to its own time, so that window is the cap plus a
     * pass interval long. A reset threshold equal to the cap called that stale
     * and dropped it: the hour the transaction had only delayed was lost after
     * all, at the moment it ended.
     *
     * Intervals shrunk through the seams: a two second cap, a four second
     * threshold, no lag.
     */
    it.skipIf(helper.isPglite || helper.isCockroachDb || helper.isYugabyteDb)('counts the window a transaction held back once it ends', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      const window: plans.DeltaWindowOptions = { lag: "interval '0'", holdBackMax: "interval '2 seconds'", resetMax: "interval '4 seconds'" }
      await monitorPass(queue, true, true, window)

      const holder = new pg.Client({ connectionString: helper.getConnectionString() })
      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query('SELECT 1')
        // Open past the cap, so the pass ends its window the cap behind itself.
        await new Promise(resolve => setTimeout(resolve, 2_500))

        // Sent inside the held-back stretch: after this pass's end, before the next one's.
        await ctx.boss.send(queue)
        const held = await monitorPass(queue, true, true, window)
        expect(held.createdDelta).toBe(0)

        await holder.query('COMMIT')
      } finally {
        await holder.end()
      }

      // The end springs forward, and the window it closes covers the send.
      let counted = 0
      await expect.poll(async () => {
        counted += (await monitorPass(queue, true, true, window)).createdDelta
        return counted
      }, { timeout: 5_000, interval: 200 }).toBe(1)
    })

    /**
     * Another instance holding the stats lock means this pass wrote nothing,
     * and the snapshot it inserted anyway was a copy of the previous pass's
     * counters, which the history then counted twice.
     */
    // A second connection holds the lock; CockroachDB takes no advisory locks, so a pass can't lose one.
    it.skipIf(helper.isPglite || helper.isCockroachDb)('records no snapshot for a pass that lost the stats lock', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true, supervise: false, monitorIntervalSeconds: 1 })
      const schema = ctx.bossConfig.schema
      const queue = randomUUID()
      await ctx.boss.createQueue(queue)

      await ctx.boss.supervise(queue)
      await ctx.boss.send(queue)
      await ctx.boss.send(queue)
      // Aged past the lag so the next pass counts them; see the history test above.
      await age(queue, '2 minutes')
      await windBack(queue, '3 minutes')
      await new Promise(resolve => setTimeout(resolve, 1100))
      await ctx.boss.supervise(queue)

      const holder = new pg.Client({ connectionString: helper.getConnectionString() })
      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query(`SELECT pg_advisory_xact_lock(${plans.advisoryLockKey(schema, 'queue-stats')})`)
        await new Promise(resolve => setTimeout(resolve, 1100))
        await ctx.boss.supervise(queue)
        await holder.query('COMMIT')
      } finally {
        await holder.end()
      }

      const series = await ctx.boss.getQueueStats(queue)
      expect(series.reduce((sum, row) => sum + (row.createdDelta ?? 0), 0)).toBe(2)
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
