import type { QueueThroughputPoint, QueueThroughputSeries } from './types'

// The /stats pages compare an interval with the one before it. Both are rolling: "this hour" is the
// last 60 minutes, not the clock hour. Each interval is a whole number of buckets, and the windows
// end at the close of the bucket in progress, so every boundary is a bucket boundary and no bucket
// is split between the two windows. The newest bucket is partly in the future and counts what it has.
export const STATS_INTERVALS = {
  '1h': { seconds: 3600, bucketSeconds: 60, noun: 'hour' },
  '6h': { seconds: 6 * 3600, bucketSeconds: 300, noun: '6 hours' },
  '24h': { seconds: 24 * 3600, bucketSeconds: 900, noun: '24 hours' },
} as const

export type StatsInterval = keyof typeof STATS_INTERVALS

export const DEFAULT_STATS_INTERVAL: StatsInterval = '1h'

export function parseStatsInterval (raw: string | null | undefined): StatsInterval {
  return raw != null && Object.hasOwn(STATS_INTERVALS, raw) ? raw as StatsInterval : DEFAULT_STATS_INTERVAL
}

export interface StatsWindow {
  from: Date;
  to: Date;
}

export interface StatsWindows {
  bucketSeconds: number;
  previous: StatsWindow;
  current: StatsWindow;
}

export function statsWindows (interval: StatsInterval, now: Date = new Date()): StatsWindows {
  const { seconds, bucketSeconds } = STATS_INTERVALS[interval]
  const end = (Math.floor(now.getTime() / 1000 / bucketSeconds) + 1) * bucketSeconds
  const at = (s: number) => new Date(s * 1000)
  return {
    bucketSeconds,
    previous: { from: at(end - 2 * seconds), to: at(end - seconds) },
    current: { from: at(end - seconds), to: at(end) },
  }
}

/** Jobs that left the queue, completed or failed: the side of the flow that arrivals are measured against. */
export function settledPerMin (point: QueueThroughputPoint): number | null {
  const { completedPerMin: c, failedPerMin: f } = point
  return c == null && f == null ? null : (c ?? 0) + (f ?? 0)
}

/** Every bucket in [from, to), in order, with an empty point where the query returned none. */
export function fillBuckets (points: QueueThroughputPoint[], window: StatsWindow, bucketSeconds: number): QueueThroughputPoint[] {
  const byStart = new Map(points.map((p) => [p.bucketStart, p]))
  const out: QueueThroughputPoint[] = []
  for (let t = window.from.getTime() / 1000; t < window.to.getTime() / 1000; t += bucketSeconds) {
    out.push(byStart.get(t) ?? { bucketStart: t, arrivedPerMin: null, completedPerMin: null, failedPerMin: null, readyCount: null })
  }
  return out
}

/**
 * The mean of a rate over the buckets in a window, ignoring buckets where nothing was counted.
 * Null when no bucket in the window has a value. Buckets are equal width, so a plain mean is the
 * window's rate.
 */
export function windowAverage (
  points: QueueThroughputPoint[],
  window: StatsWindow,
  rate: (p: QueueThroughputPoint) => number | null
): number | null {
  const from = window.from.getTime() / 1000
  const to = window.to.getTime() / 1000
  let sum = 0
  let n = 0
  for (const p of points) {
    if (p.bucketStart < from || p.bucketStart >= to) continue
    const v = rate(p)
    if (v == null) continue
    sum += v
    n++
  }
  return n === 0 ? null : sum / n
}

/**
 * The change from previous to current as a fraction (0.38 is +38%). Null when either side is
 * unknown. From zero, any rise is Infinity, which the page words as "up from zero".
 */
export function percentChange (current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null
  if (previous === 0) return current === 0 ? 0 : Infinity
  return (current - previous) / previous
}

/**
 * The series for all queues together: each bucket's rates and ready count summed across queues.
 * Each queue's rate is already its own sum(delta) / sum(seconds), so summing rates is correct where
 * pooling the raw counts would not be. A bucket where no queue has a value stays null.
 */
export function sumSeries (series: QueueThroughputSeries[]): QueueThroughputPoint[] {
  const add = (a: number | null, b: number | null) => (b == null ? a : (a ?? 0) + b)
  const byStart = new Map<number, QueueThroughputPoint>()
  for (const { points } of series) {
    for (const p of points) {
      const acc = byStart.get(p.bucketStart)
      if (!acc) {
        byStart.set(p.bucketStart, { ...p })
        continue
      }
      acc.arrivedPerMin = add(acc.arrivedPerMin, p.arrivedPerMin)
      acc.completedPerMin = add(acc.completedPerMin, p.completedPerMin)
      acc.failedPerMin = add(acc.failedPerMin, p.failedPerMin)
      acc.readyCount = add(acc.readyCount, p.readyCount)
    }
  }
  return [...byStart.values()].sort((a, b) => a.bucketStart - b.bucketStart)
}

/** Busiest first: highest arrival rate in the current window, queues with no rate last, then by name. */
export function byBusiest<T extends { name: string, arrivedPerMin: number | null }> (a: T, b: T): number {
  if (a.arrivedPerMin !== b.arrivedPerMin) {
    if (a.arrivedPerMin == null) return 1
    if (b.arrivedPerMin == null) return -1
    return b.arrivedPerMin - a.arrivedPerMin
  }
  return a.name.localeCompare(b.name)
}
