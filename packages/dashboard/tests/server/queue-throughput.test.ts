import { describe, it, expect } from 'vitest'
import pg from 'pg'
import { ctx, createTestQueue, insertQueueStatsHistory } from './helpers'
import { getQueueThroughput, getThroughputOverview } from '~/lib/queries.server'

const MISSING_SCHEMA = 'pgboss_does_not_exist_xyz'
const BUCKET = 300

// A bucket boundary two hours back, so every row below lands on a known bucket.
const t0 = Math.floor((Date.now() / 1000 - 7200) / BUCKET) * BUCKET
const at = (seconds: number) => new Date((t0 + seconds) * 1000)
const window = { from: at(0), to: at(3600), bucketSeconds: BUCKET }
// What a v44 point carries when its passes recorded no wait and run times.
const UNMEASURED = { waitBins: null, runBins: null, oldestReadySeconds: null }

describe('getQueueThroughput', () => {
  it('returns [] when no stats have been recorded', async () => {
    await createTestQueue('tp-empty')
    expect(await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-empty', window)).toEqual([])
  })

  it('returns [] when the queue_stats table is absent (before v35)', async () => {
    expect(await getQueueThroughput(ctx.connectionString, MISSING_SCHEMA, 'q', window)).toEqual([])
  })

  it('returns [] when the delta columns are absent (before v43)', async () => {
    await createTestQueue('tp-old')
    await insertQueueStatsHistory(ctx.schema, 'tp-old', [{ capturedOn: at(60), readyCount: 3 }])
    const pool = new pg.Pool({ connectionString: ctx.connectionString })
    await pool.query(`ALTER TABLE ${ctx.schema}.queue_stats DROP COLUMN delta_on`)
    await pool.end()

    expect(await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-old', window)).toEqual([])
  })

  it('weights uneven passes by the seconds each covered', async () => {
    await createTestQueue('tp-rate')
    await insertQueueStatsHistory(ctx.schema, 'tp-rate', [
      { capturedOn: at(40), readyCount: 5, createdDelta: 10, completedDelta: 4, failedDelta: 2, deltaSeconds: 30 },
      { capturedOn: at(130), readyCount: 9, createdDelta: 50, completedDelta: 56, failedDelta: 0, deltaSeconds: 90 },
    ])

    const [point, ...rest] = await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-rate', window)

    // 60 created over 120 seconds is 30 a minute; averaging the two passes' rates would give 36.67.
    expect(rest).toEqual([])
    expect(point).toEqual({
      bucketStart: t0,
      arrivedPerMin: 30,
      completedPerMin: 30,
      failedPerMin: 1,
      readyCount: 9,
      ...UNMEASURED,
    })
  })

  it('leaves the rates null where no pass counted, and keeps the gauge', async () => {
    await createTestQueue('tp-null')
    await insertQueueStatsHistory(ctx.schema, 'tp-null', [{ capturedOn: at(60), readyCount: 7 }])

    expect(await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-null', window)).toEqual([
      { bucketStart: t0, arrivedPerMin: null, completedPerMin: null, failedPerMin: null, readyCount: 7, ...UNMEASURED },
    ])
  })

  it('buckets the counters on delta_on and the gauge on captured_on', async () => {
    await createTestQueue('tp-lag')
    // Captured 5 seconds into the second bucket; its counting window ended 10 seconds earlier,
    // in the first.
    await insertQueueStatsHistory(ctx.schema, 'tp-lag', [
      { capturedOn: at(BUCKET + 5), readyCount: 2, createdDelta: 6, completedDelta: 6, failedDelta: 0, deltaSeconds: 60 },
    ])

    expect(await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-lag', window)).toEqual([
      { bucketStart: t0, arrivedPerMin: 6, completedPerMin: 6, failedPerMin: 0, readyCount: null, ...UNMEASURED },
      { bucketStart: t0 + BUCKET, arrivedPerMin: null, completedPerMin: null, failedPerMin: null, readyCount: 2, ...UNMEASURED },
    ])
  })

  it('keeps only rows inside [from, to), ascending', async () => {
    await createTestQueue('tp-range')
    await insertQueueStatsHistory(ctx.schema, 'tp-range', [
      { capturedOn: at(-100), readyCount: 1, createdDelta: 1, completedDelta: 1, failedDelta: 0, deltaSeconds: 60 },
      { capturedOn: at(2 * BUCKET + 30), readyCount: 3, createdDelta: 3, completedDelta: 3, failedDelta: 0, deltaSeconds: 60 },
      { capturedOn: at(30), readyCount: 2, createdDelta: 2, completedDelta: 2, failedDelta: 0, deltaSeconds: 60 },
      { capturedOn: at(3600 + 30), readyCount: 4, createdDelta: 4, completedDelta: 4, failedDelta: 0, deltaSeconds: 60 },
    ])

    const points = await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-range', window)

    expect(points.map((p) => [p.bucketStart, p.arrivedPerMin, p.readyCount])).toEqual([
      [t0, 2, 2],
      [t0 + 2 * BUCKET, 3, 3],
    ])
  })

  it('reads only the named queue', async () => {
    await createTestQueue('tp-a')
    await createTestQueue('tp-b')
    await insertQueueStatsHistory(ctx.schema, 'tp-a', [
      { capturedOn: at(60), readyCount: 1, createdDelta: 60, completedDelta: 60, failedDelta: 0, deltaSeconds: 60 },
    ])
    await insertQueueStatsHistory(ctx.schema, 'tp-b', [
      { capturedOn: at(60), readyCount: 9, createdDelta: 1, completedDelta: 1, failedDelta: 0, deltaSeconds: 60 },
    ])

    const points = await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-a', window)

    expect(points.map((p) => [p.arrivedPerMin, p.readyCount])).toEqual([[60, 1]])
  })
})

describe('getThroughputOverview', () => {
  it('returns [] when the queue_stats table is absent (before v35)', async () => {
    expect(await getThroughputOverview(ctx.connectionString, MISSING_SCHEMA, window)).toEqual([])
  })

  it('returns one series per queue, by name, each ascending', async () => {
    await createTestQueue('ov-b')
    await createTestQueue('ov-a')
    await insertQueueStatsHistory(ctx.schema, 'ov-b', [
      { capturedOn: at(BUCKET + 30), readyCount: 4, createdDelta: 4, completedDelta: 4, failedDelta: 0, deltaSeconds: 60 },
      { capturedOn: at(30), readyCount: 2, createdDelta: 2, completedDelta: 1, failedDelta: 1, deltaSeconds: 60 },
    ])
    await insertQueueStatsHistory(ctx.schema, 'ov-a', [
      { capturedOn: at(30), readyCount: 9, createdDelta: 90, completedDelta: 90, failedDelta: 0, deltaSeconds: 60 },
    ])

    const series = await getThroughputOverview(ctx.connectionString, ctx.schema, window)

    expect(series).toEqual([
      { name: 'ov-a', points: [{ bucketStart: t0, arrivedPerMin: 90, completedPerMin: 90, failedPerMin: 0, readyCount: 9, ...UNMEASURED }] },
      {
        name: 'ov-b',
        points: [
          { bucketStart: t0, arrivedPerMin: 2, completedPerMin: 1, failedPerMin: 1, readyCount: 2, ...UNMEASURED },
          { bucketStart: t0 + BUCKET, arrivedPerMin: 4, completedPerMin: 4, failedPerMin: 0, readyCount: 4, ...UNMEASURED },
        ],
      },
    ])
  })

  it('keeps each queue\'s rate its own, not pooled across queues', async () => {
    await createTestQueue('ov-fast')
    await createTestQueue('ov-slow')
    // Pooling would give (120 + 1) / (60 + 600) * 60 = 11 a minute for both.
    await insertQueueStatsHistory(ctx.schema, 'ov-fast', [
      { capturedOn: at(70), createdDelta: 120, completedDelta: 120, failedDelta: 0, deltaSeconds: 60 },
    ])
    await insertQueueStatsHistory(ctx.schema, 'ov-slow', [
      { capturedOn: at(70), createdDelta: 1, completedDelta: 1, failedDelta: 0, deltaSeconds: 600 },
    ])

    const series = await getThroughputOverview(ctx.connectionString, ctx.schema, window)

    expect(series.map((s) => [s.name, s.points[0].arrivedPerMin])).toEqual([
      ['ov-fast', 120],
      ['ov-slow', 0.1],
    ])
  })

  it('includes a queue that has gauges but no counted pass yet', async () => {
    await createTestQueue('ov-new')
    await insertQueueStatsHistory(ctx.schema, 'ov-new', [{ capturedOn: at(30), readyCount: 5 }])

    expect(await getThroughputOverview(ctx.connectionString, ctx.schema, window)).toEqual([
      { name: 'ov-new', points: [{ bucketStart: t0, arrivedPerMin: null, completedPerMin: null, failedPerMin: null, readyCount: 5, ...UNMEASURED }] },
    ])
  })
})

// Wait and run times arrive with pg-boss 12.36 (schema v44), which the test schema is built on.
describe('wait and run times', () => {
  const SLOTS = 48

  const openPool = () => new pg.Pool({ connectionString: ctx.connectionString })

  // A histogram as the monitor stores it: a count for every slot, these ones set and the rest zero.
  const bins = (counts: Record<number, number>) => {
    const all = new Array(SLOTS).fill(0)
    for (const [slot, n] of Object.entries(counts)) all[Number(slot)] = n
    return all
  }

  async function setLatency (pool: pg.Pool, name: string, capturedOn: Date, wait: Record<number, number>, run: Record<number, number>, oldest: number) {
    await pool.query(
      `UPDATE ${ctx.schema}.queue_stats
          SET wait_bins = $3, run_bins = $4, oldest_ready_seconds = $5
        WHERE name = $1 AND captured_on = $2`,
      [name, capturedOn, bins(wait), bins(run), oldest])
  }

  it('adds the histograms of every pass in a bucket, and keeps the longest oldest-ready wait', async () => {
    await createTestQueue('tp-latency')
    await insertQueueStatsHistory(ctx.schema, 'tp-latency', [
      { capturedOn: at(40), readyCount: 1, createdDelta: 1, completedDelta: 1, failedDelta: 0, deltaSeconds: 30 },
      { capturedOn: at(130), readyCount: 1, createdDelta: 1, completedDelta: 3, failedDelta: 0, deltaSeconds: 90 },
    ])
    const pool = openPool()
    await setLatency(pool, 'tp-latency', at(40), { 10: 1 }, { 4: 1 }, 12)
    await setLatency(pool, 'tp-latency', at(130), { 10: 2, 12: 1 }, { 5: 3 }, 30)
    await pool.end()

    const [point] = await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-latency', window)

    expect(point.waitBins).toHaveLength(SLOTS)
    expect(point.waitBins?.[10]).toBe(3)
    expect(point.waitBins?.[12]).toBe(1)
    expect(point.runBins?.[4]).toBe(1)
    expect(point.runBins?.[5]).toBe(3)
    expect(point.waitBins?.reduce((a, b) => a + b, 0)).toBe(4)
    expect(point.oldestReadySeconds).toBe(30)

    const [series] = await getThroughputOverview(ctx.connectionString, ctx.schema, window)
    expect(series.points[0].waitBins?.[10]).toBe(3)
  })

  it('reports all-zero histograms for a bucket whose passes measured and saw nothing finish', async () => {
    await createTestQueue('tp-latency-idle')
    await insertQueueStatsHistory(ctx.schema, 'tp-latency-idle', [
      { capturedOn: at(40), readyCount: 1, createdDelta: 1, completedDelta: 0, failedDelta: 0, deltaSeconds: 30 },
    ])
    const pool = openPool()
    await setLatency(pool, 'tp-latency-idle', at(40), {}, {}, 25)
    await pool.end()

    const [point] = await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-latency-idle', window)
    expect(point.waitBins).toEqual(new Array(SLOTS).fill(0))
    expect(point.runBins).toEqual(new Array(SLOTS).fill(0))
    expect(point.oldestReadySeconds).toBe(25)
  })

  it('reports no histogram for a bucket whose passes did not measure', async () => {
    await createTestQueue('tp-latency-none')
    await insertQueueStatsHistory(ctx.schema, 'tp-latency-none', [
      { capturedOn: at(40), readyCount: 1, createdDelta: 1, completedDelta: 0, failedDelta: 0, deltaSeconds: 30 },
    ])
    const pool = openPool()
    await pool.end()

    const [point] = await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-latency-none', window)
    expect(point.waitBins).toBeNull()
    expect(point.runBins).toBeNull()
    expect(point.oldestReadySeconds).toBeNull()
  })

  it('leaves the fields off entirely on a database before v44', async () => {
    await createTestQueue('tp-latency-old')
    await insertQueueStatsHistory(ctx.schema, 'tp-latency-old', [
      { capturedOn: at(40), readyCount: 1, createdDelta: 1, completedDelta: 1, failedDelta: 0, deltaSeconds: 30 },
    ])
    // Back to the v43 shape, as the migration's uninstall leaves it.
    const pool = openPool()
    await pool.query(`ALTER TABLE ${ctx.schema}.queue_stats
      DROP COLUMN wait_bins, DROP COLUMN run_bins,
      DROP COLUMN oldest_ready_seconds`)
    await pool.end()

    const [point] = await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-latency-old', window)
    expect(point).not.toHaveProperty('waitBins')
  })
})
