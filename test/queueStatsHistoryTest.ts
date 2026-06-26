import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import { ctx } from './hooks.ts'
import { delay } from '../src/tools.ts'
import * as plans from '../src/plans.ts'
import * as migrationStore from '../src/migrationStore.ts'

describe('queueStatsHistory', function () {
  const queue = `q${randomUUID().replaceAll('-', '')}`

  it('returns a single datapoint and persists nothing when persistQueueStats is off (default)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.createQueue(queue)
    await ctx.boss.send(queue)

    await ctx.boss.supervise(queue)

    // With persistence off there's no recorded series, just one current datapoint (here from the cache
    // the supervise() call populated)
    const rows = await ctx.boss.getQueueStats(queue)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe(queue)
    expect(rows[0].queuedCount).toBe(1)
    expect(rows[0].capturedOn).toBeInstanceOf(Date)

    // ...and nothing is written to the queue_stats table
    const db = await helper.getDb()
    const { rows: persisted } = await db.executeSql(
      `SELECT count(*)::int as c FROM ${ctx.schema}.queue_stats WHERE name = $1`, [queue])
    await db.close()
    expect(persisted[0].c).toBe(0)
  })

  it('serves the cache and forces recompute only when the cache is older than 60s (persistQueueStats off)', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start(ctx.bossConfig) // supervise is off in tests, so no background monitor
    await ctx.boss.createQueue(q)
    await ctx.boss.send(q)

    // First read of a never-monitored queue recomputes from the job table and caches the result
    const [first] = await ctx.boss.getQueueStats(q)
    expect(first.queuedCount).toBe(1)

    // Add a job. The cache value is now stale (1)...
    await ctx.boss.send(q)

    // ...a plain read serves the cache (well within the ~1h budget)
    const [cachedRead] = await ctx.boss.getQueueStats(q)
    expect(cachedRead.queuedCount).toBe(1)

    // ...and force also reuses it, because it was computed less than 60s ago
    const [forcedFresh] = await ctx.boss.getQueueStats(q, { force: true })
    expect(forcedFresh.queuedCount).toBe(1)

    // Age the cache past 60s but within the 1h plain budget
    const db = await helper.getDb()
    await db.executeSql(
      `UPDATE ${ctx.schema}.queue SET monitor_on = now() - interval '90 seconds' WHERE name = $1`, [q])
    await db.close()

    // A plain read still serves the (90s-old) cache...
    const [stillCached] = await ctx.boss.getQueueStats(q)
    expect(stillCached.queuedCount).toBe(1)

    // ...but force now recomputes, since the cache is older than 60s
    const [forcedStale] = await ctx.boss.getQueueStats(q, { force: true })
    expect(forcedStale.queuedCount).toBe(2)
  })

  it('recomputes when the cached counts are stale (persistQueueStats off)', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start(ctx.bossConfig) // supervise is off in tests
    await ctx.boss.createQueue(q)
    await ctx.boss.send(q)

    // populate the cache (first read recomputes and stamps monitor_on = now)
    const [first] = await ctx.boss.getQueueStats(q)
    expect(first.queuedCount).toBe(1)

    // add a job, then age the cache well past the 1-hour staleness budget
    await ctx.boss.send(q)
    const db = await helper.getDb()
    await db.executeSql(
      `UPDATE ${ctx.schema}.queue SET monitor_on = now() - interval '2 hours' WHERE name = $1`, [q])
    await db.close()

    // a plain read must treat the stale cache as untrustworthy and recompute
    const [stale] = await ctx.boss.getQueueStats(q)
    expect(stale.queuedCount).toBe(2)
  })

  it('should write stats rows and return them after supervise when persistQueueStats is on', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true, monitorIntervalSeconds: 1 })
    await ctx.boss.createQueue(q)
    await ctx.boss.send(q)
    await ctx.boss.send(q)

    await ctx.boss.supervise(q)

    const rows = await ctx.boss.getQueueStats(q)
    expect(rows.length).toBeGreaterThan(0)

    const snapshot = rows[0]
    expect(snapshot.name).toBe(q)
    expect(snapshot.queuedCount).toBe(2)
    expect(snapshot.readyCount).toBe(2)
    expect(snapshot.deferredCount).toBe(0)
    expect(snapshot.activeCount).toBe(0)
    expect(snapshot.failedCount).toBe(0)
    expect(snapshot.totalCount).toBe(2)
    expect(snapshot.capturedOn).toBeInstanceOf(Date)
  })

  it('records snapshots that match the cached queue counts', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true, monitorIntervalSeconds: 1 })
    await ctx.boss.createQueue(q)
    await ctx.boss.send(q)

    await ctx.boss.supervise(q)

    // The latest snapshot is copied from the same cached counts getQueue() exposes
    const queue = await ctx.boss.getQueue(q)
    const [snap] = await ctx.boss.getQueueStats(q)

    helper.assertTruthy(queue)
    expect(snap.queuedCount).toBe(queue.queuedCount)
    expect(snap.readyCount).toBe(queue.readyCount)
    expect(snap.totalCount).toBe(queue.totalCount)
  })

  it('should filter by from/to range', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true, monitorIntervalSeconds: 1 })
    await ctx.boss.createQueue(q)
    await ctx.boss.send(q)

    const before = new Date()
    await ctx.boss.supervise(q)
    const after = new Date()

    const rowsAll = await ctx.boss.getQueueStats(q)
    expect(rowsAll.length).toBeGreaterThan(0)

    const rowsFrom = await ctx.boss.getQueueStats(q, { from: before })
    expect(rowsFrom.length).toBeGreaterThan(0)

    const rowsTo = await ctx.boss.getQueueStats(q, { to: after })
    expect(rowsTo.length).toBeGreaterThan(0)

    const rowsNone = await ctx.boss.getQueueStats(q, { from: new Date(after.getTime() + 60_000) })
    expect(rowsNone).toHaveLength(0)
  })

  it('should respect limit option', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true, monitorIntervalSeconds: 1 })
    await ctx.boss.createQueue(q)
    await ctx.boss.send(q)

    await ctx.boss.supervise(q)
    await ctx.boss.supervise(q)
    await ctx.boss.supervise(q)

    const limited = await ctx.boss.getQueueStats(q, { limit: 2 })
    expect(limited.length).toBeLessThanOrEqual(2)
  })

  // Seed queue_stats rows directly with controlled captured_on/counts so bucketing is deterministic.
  // All timestamps are `agoSeconds` before now (kept within today's UTC partition), and the partition
  // is ensured first so partitioned Postgres accepts the inserts.
  async function seedStats (q: string, rows: Array<{ ago: number, queued?: number, total?: number }>) {
    const db = await helper.getDb()
    await db.executeSql(plans.ensureQueueStatsPartitions(ctx.schema))
    for (const r of rows) {
      await db.executeSql(
        `INSERT INTO ${ctx.schema}.queue_stats
           (name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count, captured_on)
         VALUES ($1, 0, $2, 0, 0, 0, $3, now() - ($4 || ' seconds')::interval)`,
        [q, r.queued ?? 0, r.total ?? 0, String(r.ago)])
    }
    await db.close()
  }

  helper.itPostgresOnly('downsamples a large series with bucketSeconds', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)

    // 60 snapshots one second apart; 10-second buckets collapse them to ~6-7 rows
    await seedStats(q, Array.from({ length: 60 }, (_, i) => ({ ago: i, queued: i })))

    const buckets = await ctx.boss.getQueueStats(q, { bucketSeconds: 10 })
    expect(buckets.length).toBeLessThan(60)
    expect(buckets.length).toBeLessThanOrEqual(8)
    expect(buckets[0].capturedOn).toBeInstanceOf(Date)
    // newest bucket first
    expect(buckets[0].capturedOn.getTime()).toBeGreaterThan(buckets.at(-1)!.capturedOn.getTime())
  })

  helper.itPostgresOnly('applies max/min/avg within a bucket', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)

    // two rows a couple seconds apart; a wide bucket collapses both into one
    await seedStats(q, [{ ago: 1, queued: 10 }, { ago: 2, queued: 21 }])

    const [mx] = await ctx.boss.getQueueStats(q, { bucketSeconds: 3600, aggregate: 'max' })
    const [mn] = await ctx.boss.getQueueStats(q, { bucketSeconds: 3600, aggregate: 'min' })
    const [av] = await ctx.boss.getQueueStats(q, { bucketSeconds: 3600, aggregate: 'avg' })

    expect(mx.queuedCount).toBe(21)
    expect(mn.queuedCount).toBe(10)
    expect(av.queuedCount).toBe(16) // round(avg(10,21)) = round(15.5) = 16
    expect(Number.isInteger(av.queuedCount)).toBe(true)
  })

  helper.itPostgresOnly('defaults to max when aggregate is omitted', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)
    await seedStats(q, [{ ago: 1, queued: 10 }, { ago: 2, queued: 21 }])

    const [bucket] = await ctx.boss.getQueueStats(q, { bucketSeconds: 3600 })
    expect(bucket.queuedCount).toBe(21)
  })

  helper.itPostgresOnly('maxDataPoints fits the series into ~N points', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)

    // 120 snapshots over two minutes; target 10 points
    await seedStats(q, Array.from({ length: 120 }, (_, i) => ({ ago: i, queued: i })))

    const points = await ctx.boss.getQueueStats(q, { maxDataPoints: 10 })
    expect(points.length).toBeGreaterThan(1)
    expect(points.length).toBeLessThanOrEqual(11) // ~N, allow a boundary-straddling extra bucket
  })

  helper.itPostgresOnly('maxDataPoints derives the bucket width from an explicit from/to window', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)
    await seedStats(q, Array.from({ length: 20 }, (_, i) => ({ ago: i, queued: i })))

    // whole-second bounds so the derived width is an exact integer and buckets align cleanly
    const to = new Date(Math.floor(Date.now() / 1000) * 1000 + 1000)
    const from = new Date(to.getTime() - 100_000) // 100s window
    const maxDataPoints = 10
    const expectedWidth = Math.max(1, Math.ceil(((to.getTime() - from.getTime()) / 1000) / maxDataPoints))

    const points = await ctx.boss.getQueueStats(q, { from, to, maxDataPoints })
    expect(points.length).toBeGreaterThan(0)
    expect(points.length).toBeLessThanOrEqual(maxDataPoints + 1)
    // every bucket boundary aligns to the width derived from (to-from)/maxDataPoints, not the data span
    for (const p of points) {
      expect(Math.round(p.capturedOn.getTime() / 1000) % expectedWidth).toBe(0)
    }
  })

  it('bucketSeconds wins when both bucketSeconds and maxDataPoints are passed', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)
    // both supplied; an invalid maxDataPoints must be ignored because bucketSeconds takes precedence
    await expect(ctx.boss.getQueueStats(q, { bucketSeconds: 60, maxDataPoints: 0 })).resolves.toBeInstanceOf(Array)
  })

  it('rejects a non-integer or non-positive bucketSeconds / maxDataPoints', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)

    await expect(ctx.boss.getQueueStats(q, { bucketSeconds: 0 })).rejects.toThrow('bucketSeconds')
    await expect(ctx.boss.getQueueStats(q, { bucketSeconds: 1.5 })).rejects.toThrow('bucketSeconds')
    await expect(ctx.boss.getQueueStats(q, { maxDataPoints: -10 })).rejects.toThrow('maxDataPoints')
    await expect(ctx.boss.getQueueStats(q, { maxDataPoints: 2.5 })).rejects.toThrow('maxDataPoints')
  })

  it('rejects an invalid aggregate', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)
    // @ts-expect-error invalid aggregate
    await expect(ctx.boss.getQueueStats(q, { bucketSeconds: 60, aggregate: 'sum' })).rejects.toThrow('aggregate')
  })

  // The bucket expression must stay portable: no date_bin() (PG14+, unsupported on CockroachDB),
  // built from to_timestamp/extract(epoch)/floor which exist on PG13+ and the distributed backends.
  it('builds a portable bucket expression (no date_bin)', function () {
    const sql = plans.getQueueStatsHistoryBucketed('pgboss', 'max', 'bucket')
    expect(sql).not.toContain('date_bin')
    expect(sql).toContain('to_timestamp')
  })

  // The covering INCLUDE is gated on noCoveringIndexes: present by default (Postgres/Yugabyte),
  // stripped for CockroachDB which uses STORING instead of INCLUDE.
  it('emits a covering queue_stats index unless noCoveringIndexes is set', function () {
    expect(plans.createIndexQueueStats('pgboss')).toContain('INCLUDE')
    expect(plans.createIndexQueueStats('pgboss', true)).not.toContain('INCLUDE')
  })

  it('should validate queueStatRetentionDays < 1', async function () {
    await expect(helper.start({ ...ctx.bossConfig, persistQueueStats: true, queueStatRetentionDays: 0 })).rejects.toThrow('queueStatRetentionDays')
  })

  it('should validate queueStatRetentionDays > 365', async function () {
    await expect(helper.start({ ...ctx.bossConfig, persistQueueStats: true, queueStatRetentionDays: 366 })).rejects.toThrow('queueStatRetentionDays')
  })

  helper.itPostgresOnly('should create a daily partition for today', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true, monitorIntervalSeconds: 1 })
    await ctx.boss.createQueue(q)
    await ctx.boss.send(q)

    await ctx.boss.supervise(q)

    const todaySuffix = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const db = await helper.getDb()
    const { rows } = await db.executeSql(
      `SELECT relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ctx.schema, `queue_stats_${todaySuffix}`]
    )
    await db.close()
    expect(rows.length).toBe(1)
  })

  helper.itPostgresOnly('should drop old partitions during maintenance', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      persistQueueStats: true,
      queueStatRetentionDays: 7,
      supervise: true,
      superviseIntervalSeconds: 1
    })
    await ctx.boss.createQueue(q)

    // Create a stale partition (10 days ago)
    const oldDate = new Date()
    oldDate.setUTCDate(oldDate.getUTCDate() - 10)
    const oldDateStr = oldDate.toISOString().slice(0, 10)
    const oldSuffix = oldDateStr.replace(/-/g, '')
    const nextDay = new Date(oldDate)
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    const nextDayStr = nextDay.toISOString().slice(0, 10)

    const db = await helper.getDb()
    await db.executeSql(
      `CREATE TABLE IF NOT EXISTS ${ctx.schema}.queue_stats_${oldSuffix} PARTITION OF ${ctx.schema}.queue_stats FOR VALUES FROM ('${oldDateStr}') TO ('${nextDayStr}')`
    )
    await db.close()

    // Verify partition exists
    const db2 = await helper.getDb()
    const before = await db2.executeSql(
      `SELECT relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ctx.schema, `queue_stats_${oldSuffix}`]
    )
    await db2.close()
    expect(before.rows.length).toBe(1)

    // Wait for the supervise interval to fire #maintainQueueStats
    await delay(2000)

    await ctx.boss.stop()

    // Old partition should be gone
    const db3 = await helper.getDb()
    const after = await db3.executeSql(
      `SELECT relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ctx.schema, `queue_stats_${oldSuffix}`]
    )
    await db3.close()
    expect(after.rows.length).toBe(0)
  })

  helper.itPostgresOnly('should drop old partitions via a manual supervise() call with the supervisor disabled', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      persistQueueStats: true,
      queueStatRetentionDays: 7,
      supervise: false
    })
    await ctx.boss.createQueue(q)

    // Create a stale partition (10 days ago)
    const oldDate = new Date()
    oldDate.setUTCDate(oldDate.getUTCDate() - 10)
    const oldDateStr = oldDate.toISOString().slice(0, 10)
    const oldSuffix = oldDateStr.replace(/-/g, '')
    const nextDay = new Date(oldDate)
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    const nextDayStr = nextDay.toISOString().slice(0, 10)

    const db = await helper.getDb()
    await db.executeSql(
      `CREATE TABLE IF NOT EXISTS ${ctx.schema}.queue_stats_${oldSuffix} PARTITION OF ${ctx.schema}.queue_stats FOR VALUES FROM ('${oldDateStr} 00:00:00+00') TO ('${nextDayStr} 00:00:00+00')`
    )
    await db.close()

    // A manual supervise() call must run retention, not just per-queue monitoring/maintenance
    await ctx.boss.supervise()

    const db2 = await helper.getDb()
    const after = await db2.executeSql(
      `SELECT relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ctx.schema, `queue_stats_${oldSuffix}`]
    )
    await db2.close()
    expect(after.rows.length).toBe(0)
  })

  it('should reject a non-integer or out-of-range limit', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    // limit only applies to the recorded series, so validation lives in the persistence-on path
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    await ctx.boss.createQueue(q)

    await expect(ctx.boss.getQueueStats(q, { limit: 0 })).rejects.toThrow('limit')
    await expect(ctx.boss.getQueueStats(q, { limit: 1.5 })).rejects.toThrow('limit')
    await expect(ctx.boss.getQueueStats(q, { limit: 100_001 })).rejects.toThrow('limit')
  })

  helper.itPostgresOnly('deletes old stats rows during maintenance under noTablePartitioning', async function () {
    const q = `q${randomUUID().replaceAll('-', '')}`
    // backend: 'cockroachdb' forces noTablePartitioning, so queue_stats is a plain table pruned by
    // row deletion rather than partition drops
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      backend: 'cockroachdb',
      persistQueueStats: true,
      queueStatRetentionDays: 7,
      noDefault: true
    })

    const db = await helper.getDb()
    await db.executeSql(
      `INSERT INTO ${ctx.schema}.queue_stats (name, captured_on) VALUES ($1, now() - interval '10 days')`, [q])
    await db.close()

    // supervise() runs retention in its tail; with no queues it goes straight there
    await ctx.boss.supervise()

    const db2 = await helper.getDb()
    const { rows } = await db2.executeSql(
      `SELECT count(*)::int as c FROM ${ctx.schema}.queue_stats WHERE name = $1`, [q])
    await db2.close()
    expect(rows[0].c).toBe(0)
  })

  it('rejects an unknown queue (persistQueueStats off)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const unknown = `q${randomUUID().replaceAll('-', '')}`
    await expect(ctx.boss.getQueueStats(unknown)).rejects.toThrow('does not exist')
  })

  it('rejects an unknown queue (persistQueueStats on)', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistQueueStats: true })
    const unknown = `q${randomUUID().replaceAll('-', '')}`
    await expect(ctx.boss.getQueueStats(unknown)).rejects.toThrow('does not exist')
  })

  // Partition bounds must be emitted as explicit UTC (`+00`) timestamptz literals. A bare date
  // literal would be cast to timestamptz in the database session TimeZone, so rows written near UTC
  // midnight on a non-UTC server could fall outside every partition and fail to insert.
  it('emits partition bounds in UTC', function () {
    const sql = plans.ensureQueueStatsPartitions('pgboss')
    expect(sql).toContain("' 00:00:00+00'")
    expect(sql).not.toMatch(/FROM \('20\d{2}-\d{2}-\d{2}'\)/)
  })

  // The v35 migration must mirror plans.create() and honor noTablePartitioning, so non-partitioning
  // backends (CockroachDB/YugabyteDB) get a plain table they can actually maintain.
  it('v35 migration creates a partitioned table by default and a plain table under noTablePartitioning', function () {
    const partitioned = migrationStore.getAll('pgboss').find(m => m.version === 35)
    const plain = migrationStore.getAll('pgboss', true).find(m => m.version === 35)

    expect(partitioned!.install.join('\n')).toContain('PARTITION BY RANGE')
    expect(plain!.install.join('\n')).not.toContain('PARTITION BY')
    expect(plain!.install.join('\n')).not.toContain('PARTITION OF')
    expect(plain!.install.join('\n')).toContain('CREATE TABLE pgboss.queue_stats')
  })
})
