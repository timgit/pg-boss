import { describe, it, expect, beforeEach } from 'vitest'
import pg from 'pg'
import { ctx, createTestQueue, insertQueueStatsHistory } from './helpers'
import {
  getQueues,
  getQueue,
  getQueueStatsHistory,
  getQueueStatsCollectionStatus,
  resolveAggregate,
  clearReadyHistoryColumnCache,
} from '~/lib/queries.server'

const MISSING_SCHEMA = 'pgboss_does_not_exist_xyz'

// Helper: timestamps relative to now (kept inside the last hour so they land in the recent window).
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe('resolveAggregate', () => {
  it('passes through valid aggregates and defaults the rest to max', () => {
    expect(resolveAggregate('min')).toBe('min')
    expect(resolveAggregate('avg')).toBe('avg')
    expect(resolveAggregate('max')).toBe('max')
    expect(resolveAggregate(null)).toBe('max')
    expect(resolveAggregate('nonsense')).toBe('max')
  })
})

describe('getQueueStatsHistory', () => {
  it('returns [] when no stats have been recorded', async () => {
    await createTestQueue('empty-q')
    expect(await getQueueStatsHistory(ctx.connectionString, ctx.schema, 'empty-q')).toEqual([])
  })

  it('returns [] when the queue_stats table is absent (older schema)', async () => {
    expect(await getQueueStatsHistory(ctx.connectionString, MISSING_SCHEMA, 'q')).toEqual([])
  })

  it('returns points ascending by time', async () => {
    await createTestQueue('asc-q')
    await insertQueueStatsHistory(ctx.schema, 'asc-q', [
      { capturedOn: minutesAgo(30), readyCount: 1 },
      { capturedOn: minutesAgo(20), readyCount: 2 },
      { capturedOn: minutesAgo(10), readyCount: 3 },
    ])

    const points = await getQueueStatsHistory(ctx.connectionString, ctx.schema, 'asc-q', {
      maxDataPoints: 100,
    })

    expect(points.length).toBeGreaterThanOrEqual(1)
    const times = points.map((p) => p.capturedOn)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('downsamples to at most maxDataPoints buckets', async () => {
    await createTestQueue('cap-q')
    const rows = Array.from({ length: 30 }, (_, i) => ({
      capturedOn: minutesAgo(30 - i),
      readyCount: i,
    }))
    await insertQueueStatsHistory(ctx.schema, 'cap-q', rows)

    const points = await getQueueStatsHistory(ctx.connectionString, ctx.schema, 'cap-q', {
      maxDataPoints: 5,
    })

    expect(points.length).toBeGreaterThan(0)
    expect(points.length).toBeLessThanOrEqual(5)
  })

  it('collapses each bucket with the chosen aggregate', async () => {
    await createTestQueue('agg-q')
    // Two pairs of rows sharing a timestamp → each pair always lands in one bucket, so the
    // aggregate is deterministic regardless of where the epoch-aligned bucket boundaries fall.
    const t1 = minutesAgo(20)
    const t2 = minutesAgo(10)
    await insertQueueStatsHistory(ctx.schema, 'agg-q', [
      { capturedOn: t1, readyCount: 2 },
      { capturedOn: t1, readyCount: 8 },
      { capturedOn: t2, readyCount: 4 },
      { capturedOn: t2, readyCount: 6 },
    ])

    const opts = { maxDataPoints: 100 }
    const max = await getQueueStatsHistory(ctx.connectionString, ctx.schema, 'agg-q', { ...opts, aggregate: 'max' })
    const min = await getQueueStatsHistory(ctx.connectionString, ctx.schema, 'agg-q', { ...opts, aggregate: 'min' })
    const avg = await getQueueStatsHistory(ctx.connectionString, ctx.schema, 'agg-q', { ...opts, aggregate: 'avg' })

    expect(max.map((p) => p.readyCount)).toEqual([8, 6])
    expect(min.map((p) => p.readyCount)).toEqual([2, 4])
    expect(avg.map((p) => p.readyCount)).toEqual([5, 5])
  })

  it('honors the from bound', async () => {
    await createTestQueue('range-q')
    await insertQueueStatsHistory(ctx.schema, 'range-q', [
      { capturedOn: minutesAgo(50), readyCount: 1 },
      { capturedOn: minutesAgo(40), readyCount: 2 },
      { capturedOn: minutesAgo(5), readyCount: 9 },
    ])

    const from = minutesAgo(30)
    const points = await getQueueStatsHistory(ctx.connectionString, ctx.schema, 'range-q', {
      from,
      maxDataPoints: 100,
    })

    expect(points.length).toBeGreaterThanOrEqual(1)
    const fromSeconds = Math.floor(from.getTime() / 1000)
    for (const p of points) expect(p.capturedOn).toBeGreaterThanOrEqual(fromSeconds)
  })
})

describe('queue.ready_history (sparkline column)', () => {
  beforeEach(() => clearReadyHistoryColumnCache())

  const setReadyHistory = async (name: string, values: number[]) => {
    const pool = new pg.Pool({ connectionString: ctx.connectionString })
    await pool.query(`UPDATE ${ctx.schema}.queue SET ready_history = $2::int[] WHERE name = $1`, [name, values])
    await pool.end()
  }

  it('getQueues returns readyHistory (newest-first) when the column exists', async () => {
    await createTestQueue('rh-list')
    await setReadyHistory('rh-list', [7, 5, 3])

    const queues = await getQueues(ctx.connectionString, ctx.schema, {})
    const queue = queues.find((q) => q.name === 'rh-list')
    expect(queue?.readyHistory).toEqual([7, 5, 3])
  })

  it('getQueue returns readyHistory for a single queue', async () => {
    await createTestQueue('rh-one')
    await setReadyHistory('rh-one', [9])

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'rh-one')
    expect(queue?.readyHistory).toEqual([9])
  })

  it('degrades gracefully when the column is absent (older schema)', async () => {
    await createTestQueue('rh-old')
    const pool = new pg.Pool({ connectionString: ctx.connectionString })
    await pool.query(`ALTER TABLE ${ctx.schema}.queue DROP COLUMN ready_history`)
    await pool.end()
    clearReadyHistoryColumnCache()

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'rh-old')
    expect(queue).toBeTruthy()
    expect(queue?.readyHistory).toBeUndefined()
  })
})

describe('getQueueStatsCollectionStatus', () => {
  it('is false when no rows have been recorded', async () => {
    await createTestQueue('status-empty')
    expect(await getQueueStatsCollectionStatus(ctx.connectionString, ctx.schema)).toEqual({ available: false })
  })

  it('is false when the queue_stats table is absent', async () => {
    expect(await getQueueStatsCollectionStatus(ctx.connectionString, MISSING_SCHEMA)).toEqual({ available: false })
  })

  it('is true once at least one row exists', async () => {
    await createTestQueue('status-q')
    await insertQueueStatsHistory(ctx.schema, 'status-q', [{ capturedOn: minutesAgo(5), readyCount: 1 }])
    expect(await getQueueStatsCollectionStatus(ctx.connectionString, ctx.schema)).toEqual({ available: true })
  })
})
