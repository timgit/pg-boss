import { describe, it, expect } from 'vitest'
import pg from 'pg'
import { ctx, createTestQueue, insertQueueStatsHistory } from './helpers'
import { getQueueThroughput } from '~/lib/queries.server'

const MISSING_SCHEMA = 'pgboss_does_not_exist_xyz'
const BUCKET = 300

// A bucket boundary two hours back, so every row below lands on a known bucket.
const t0 = Math.floor((Date.now() / 1000 - 7200) / BUCKET) * BUCKET
const at = (seconds: number) => new Date((t0 + seconds) * 1000)
const window = { from: at(0), to: at(3600), bucketSeconds: BUCKET }

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
    })
  })

  it('leaves the rates null where no pass counted, and keeps the gauge', async () => {
    await createTestQueue('tp-null')
    await insertQueueStatsHistory(ctx.schema, 'tp-null', [{ capturedOn: at(60), readyCount: 7 }])

    expect(await getQueueThroughput(ctx.connectionString, ctx.schema, 'tp-null', window)).toEqual([
      { bucketStart: t0, arrivedPerMin: null, completedPerMin: null, failedPerMin: null, readyCount: 7 },
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
      { bucketStart: t0, arrivedPerMin: 6, completedPerMin: 6, failedPerMin: 0, readyCount: null },
      { bucketStart: t0 + BUCKET, arrivedPerMin: null, completedPerMin: null, failedPerMin: null, readyCount: 2 },
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
