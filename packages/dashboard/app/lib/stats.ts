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

/**
 * A round upper bound for a chart axis: four gridline steps of 1, 2 or 5 × 10ⁿ, so every tick is a
 * round number. 1 for an empty or all-zero series, so a quiet queue still draws an axis.
 */
export function niceMax (value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 1
  const step = value / 4
  const p = 10 ** Math.floor(Math.log10(step))
  const m = step / p
  return 4 * (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

/**
 * The throughput panel's columns: bucket starts, arrivals, jobs finishing (completed + failed) and
 * failures, each per minute, null where nothing was counted.
 */
export function throughputColumns (points: QueueThroughputPoint[]): [number[], Array<number | null>, Array<number | null>, Array<number | null>] {
  return [
    points.map((p) => p.bucketStart),
    points.map((p) => p.arrivedPerMin),
    points.map(settledPerMin),
    points.map((p) => p.failedPerMin),
  ]
}

// The depth panel's series: which QueueStatsPoint gauge each plots and the CSS variable for its color.
export const DEPTH_SERIES = [
  { key: 'ready', label: 'Ready', field: 'readyCount', cssVar: '--stats-ready' },
  { key: 'active', label: 'Active', field: 'activeCount', cssVar: '--state-active-dot' },
  { key: 'queued', label: 'Queued', field: 'queuedCount', cssVar: '--warning-600' },
  { key: 'deferred', label: 'Deferred', field: 'deferredCount', cssVar: '--text-tertiary' },
  { key: 'failed', label: 'Failed', field: 'failedCount', cssVar: '--error-600' },
  { key: 'total', label: 'Total', field: 'totalCount', cssVar: '--text-secondary' },
] as const

export type DepthSeriesKey = (typeof DEPTH_SERIES)[number]['key']

/** The `series` param: absent means ready only, an empty string means none, unknown keys drop. */
export function parseDepthSeries (raw: string | null): DepthSeriesKey[] {
  if (raw === null) return ['ready']
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is DepthSeriesKey => DEPTH_SERIES.some((d) => d.key === s))
}

/**
 * The /stats/:queue query for an old /queues/:name/metrics URL. A range that is also an interval
 * carries over, as do the series, the aggregate and the database; 7d, 30d and custom ranges have no
 * interval, so the page opens on its default. The chart width is dropped: the page measures its own.
 */
export function metricsRedirectSearch (from: URLSearchParams): string {
  const to = new URLSearchParams()
  const range = from.get('range')
  if (range != null && Object.hasOwn(STATS_INTERVALS, range)) to.set('interval', range)
  for (const key of ['series', 'agg', 'db']) {
    const value = from.get(key)
    if (value != null) to.set(key, value)
  }
  const search = to.toString()
  return search ? `?${search}` : ''
}

/**
 * Fewer, wider buckets for a small chart: consecutive buckets merged in groups, at most `max`
 * points. The group size divides each window's bucket count, so no merged point spans both
 * windows. Rates are the mean of the buckets that counted something; ready is the last value seen,
 * the backlog at the end of the group.
 */
export function downsample (points: QueueThroughputPoint[], max: number): QueueThroughputPoint[] {
  const half = points.length / 2
  let size = Math.max(1, Math.ceil(points.length / max))
  while (Number.isInteger(half) && half % size !== 0) size++

  const mean = (group: QueueThroughputPoint[], rate: (p: QueueThroughputPoint) => number | null) => {
    const values = group.map(rate).filter((v): v is number => v != null)
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  }

  const out: QueueThroughputPoint[] = []
  for (let i = 0; i < points.length; i += size) {
    const group = points.slice(i, i + size)
    const ready = group.map((p) => p.readyCount).filter((v): v is number => v != null)
    out.push({
      bucketStart: group[0].bucketStart,
      arrivedPerMin: mean(group, (p) => p.arrivedPerMin),
      completedPerMin: mean(group, (p) => p.completedPerMin),
      failedPerMin: mean(group, (p) => p.failedPerMin),
      readyCount: ready.length ? ready[ready.length - 1] : null,
    })
  }
  return out
}

// One queue's tile on /stats.
export interface StatsQueueSummary {
  name: string;
  /** Averages over the current window, per minute. */
  arrivedPerMin: number | null;
  finishingPerMin: number | null;
  /** This queue's part of all arrivals in the current window, 0 to 1. Null when nothing arrived anywhere. */
  share: number | null;
  /** Both windows, the previous first, downsampled for the tile's chart. */
  points: QueueThroughputPoint[];
}

export const TILE_POINTS = 48

/**
 * A tile per queue, busiest first. Every queue named gets one, including a queue with no stats in
 * the span, which reads as nothing counted.
 */
export function queueSummaries (
  names: string[],
  series: QueueThroughputSeries[],
  windows: StatsWindows
): StatsQueueSummary[] {
  const { previous, current, bucketSeconds } = windows
  const span = { from: previous.from, to: current.to }
  const byName = new Map(series.map((s) => [s.name, s.points]))
  const tiles = names.map((name) => {
    const filled = fillBuckets(byName.get(name) ?? [], span, bucketSeconds)
    return {
      name,
      arrivedPerMin: windowAverage(filled, current, (p) => p.arrivedPerMin),
      finishingPerMin: windowAverage(filled, current, settledPerMin),
      share: null as number | null,
      points: downsample(filled, TILE_POINTS),
    }
  })
  const total = tiles.reduce((sum, t) => sum + (t.arrivedPerMin ?? 0), 0)
  for (const t of tiles) t.share = total > 0 ? (t.arrivedPerMin ?? 0) / total : null
  return tiles.sort(byBusiest)
}
