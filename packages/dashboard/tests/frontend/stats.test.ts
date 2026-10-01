import { describe, it, expect } from 'vitest'
import {
  LATENCY_SLOTS,
  STATS_INTERVALS,
  addBins,
  byBusiest,
  downsample,
  fillBuckets,
  latencySummary,
  metricsRedirectSearch,
  niceMax,
  parseDepthSeries,
  parseStatsInterval,
  percentChange,
  queueSummaries,
  settledPerMin,
  statsWindows,
  sumSeries,
  throughputColumns,
  windowAverage,
} from '~/lib/stats'
import type { QueueThroughputPoint } from '~/lib/types'

const point = (bucketStart: number, rates: Partial<QueueThroughputPoint> = {}): QueueThroughputPoint => ({
  bucketStart,
  arrivedPerMin: null,
  completedPerMin: null,
  failedPerMin: null,
  readyCount: null,
  ...rates,
})

const seconds = (d: Date) => d.getTime() / 1000

describe('parseStatsInterval', () => {
  it('accepts the three intervals and defaults the rest to 1h', () => {
    expect(parseStatsInterval('1h')).toBe('1h')
    expect(parseStatsInterval('6h')).toBe('6h')
    expect(parseStatsInterval('24h')).toBe('24h')
    expect(parseStatsInterval('15m')).toBe('1h')
    expect(parseStatsInterval('toString')).toBe('1h')
    expect(parseStatsInterval(null)).toBe('1h')
  })
})

describe('statsWindows', () => {
  it('ends at the close of the bucket in progress, with both windows one interval long', () => {
    // 10:05:30 UTC: the minute in progress closes at 10:06.
    const w = statsWindows('1h', new Date('2026-09-28T10:05:30Z'))

    expect(w.bucketSeconds).toBe(60)
    expect(w.current).toEqual({ from: new Date('2026-09-28T09:06:00Z'), to: new Date('2026-09-28T10:06:00Z') })
    expect(w.previous).toEqual({ from: new Date('2026-09-28T08:06:00Z'), to: new Date('2026-09-28T09:06:00Z') })
  })

  it('puts every boundary on a bucket boundary, for each interval', () => {
    const now = new Date('2026-09-28T10:07:31Z')
    for (const key of ['1h', '6h', '24h'] as const) {
      const w = statsWindows(key, now)
      const { seconds: len, bucketSeconds } = STATS_INTERVALS[key]
      for (const d of [w.previous.from, w.previous.to, w.current.to]) {
        expect(seconds(d) % bucketSeconds).toBe(0)
      }
      expect(seconds(w.current.to) - seconds(w.current.from)).toBe(len)
      expect(w.previous.to).toEqual(w.current.from)
      expect(w.current.to.getTime()).toBeGreaterThan(now.getTime())
    }
  })

  it('moves to the next bucket exactly on a boundary', () => {
    const w = statsWindows('1h', new Date('2026-09-28T10:06:00Z'))
    expect(w.current.to).toEqual(new Date('2026-09-28T10:07:00Z'))
  })
})

describe('settledPerMin', () => {
  it('adds completed and failed, treating a missing side as zero', () => {
    expect(settledPerMin(point(0, { completedPerMin: 30, failedPerMin: 2 }))).toBe(32)
    expect(settledPerMin(point(0, { completedPerMin: 30 }))).toBe(30)
    expect(settledPerMin(point(0, { failedPerMin: 2 }))).toBe(2)
  })

  it('is null when neither was counted', () => {
    expect(settledPerMin(point(0))).toBeNull()
  })
})

describe('fillBuckets', () => {
  it('returns every bucket in the window, keeping the points it has', () => {
    const window = { from: new Date(600_000), to: new Date(900_000) }
    const filled = fillBuckets([point(660, { arrivedPerMin: 5 })], window, 60)

    expect(filled.map((p) => p.bucketStart)).toEqual([600, 660, 720, 780, 840])
    expect(filled[1].arrivedPerMin).toBe(5)
    expect(filled[0]).toEqual(point(600))
  })
})

describe('windowAverage', () => {
  const window = { from: new Date(600_000), to: new Date(780_000) }
  const arrived = (p: QueueThroughputPoint) => p.arrivedPerMin

  it('averages the buckets inside the window that have a value', () => {
    const points = [
      point(540, { arrivedPerMin: 1000 }),
      point(600, { arrivedPerMin: 10 }),
      point(660),
      point(720, { arrivedPerMin: 20 }),
      point(780, { arrivedPerMin: 1000 }),
    ]
    expect(windowAverage(points, window, arrived)).toBe(15)
  })

  it('counts a zero rate as a value', () => {
    expect(windowAverage([point(600, { arrivedPerMin: 0 }), point(660, { arrivedPerMin: 10 })], window, arrived)).toBe(5)
  })

  it('is null when nothing in the window was counted', () => {
    expect(windowAverage([point(600), point(900, { arrivedPerMin: 3 })], window, arrived)).toBeNull()
  })
})

describe('percentChange', () => {
  it('is the change as a fraction of the previous value', () => {
    expect(percentChange(138, 100)).toBeCloseTo(0.38)
    expect(percentChange(65, 100)).toBeCloseTo(-0.35)
  })

  it('is 0 from zero to zero and Infinity from zero to anything', () => {
    expect(percentChange(0, 0)).toBe(0)
    expect(percentChange(4, 0)).toBe(Infinity)
  })

  it('is null when either side is unknown', () => {
    expect(percentChange(null, 10)).toBeNull()
    expect(percentChange(10, null)).toBeNull()
  })
})

describe('sumSeries', () => {
  it('sums each bucket across queues, skipping nulls, ascending', () => {
    const combined = sumSeries([
      { name: 'a', points: [point(660, { arrivedPerMin: 2, readyCount: 1 }), point(600, { arrivedPerMin: 10, completedPerMin: 9 })] },
      { name: 'b', points: [point(600, { arrivedPerMin: 1, failedPerMin: 1, readyCount: 4 })] },
    ])

    expect(combined).toEqual([
      point(600, { arrivedPerMin: 11, completedPerMin: 9, failedPerMin: 1, readyCount: 4 }),
      point(660, { arrivedPerMin: 2, readyCount: 1 }),
    ])
  })

  it('leaves a bucket null where no queue has a value', () => {
    expect(sumSeries([{ name: 'a', points: [point(600)] }, { name: 'b', points: [point(600)] }])).toEqual([point(600)])
  })

  it('does not change the points it was given', () => {
    const a = point(600, { arrivedPerMin: 1 })
    sumSeries([{ name: 'a', points: [a] }, { name: 'b', points: [point(600, { arrivedPerMin: 2 })] }])
    expect(a.arrivedPerMin).toBe(1)
  })
})

describe('byBusiest', () => {
  it('orders by arrival rate, then queues with none, then by name', () => {
    const queues = [
      { name: 'idle', arrivedPerMin: null },
      { name: 'b', arrivedPerMin: 5 },
      { name: 'busy', arrivedPerMin: 900 },
      { name: 'a', arrivedPerMin: 5 },
      { name: 'quiet', arrivedPerMin: 0 },
    ]
    expect(queues.sort(byBusiest).map((q) => q.name)).toEqual(['busy', 'a', 'b', 'quiet', 'idle'])
  })
})

describe('niceMax', () => {
  it('rounds up to four steps of 1, 2 or 5 × 10ⁿ', () => {
    expect(niceMax(3.7)).toBe(4)
    expect(niceMax(130)).toBe(200)
    expect(niceMax(0.32)).toBe(0.4)
    expect(niceMax(1900)).toBe(2000)
    expect(niceMax(4100)).toBe(8000)
  })

  it('gives an axis to a series with nothing on it', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(null)).toBe(1)
    expect(niceMax(Number.NaN)).toBe(1)
  })
})

describe('throughputColumns', () => {
  it('lays out times, arrivals, finishing and failures, keeping gaps', () => {
    const cols = throughputColumns([
      point(60, { arrivedPerMin: 5, completedPerMin: 3, failedPerMin: 1 }),
      point(120),
    ])
    expect(cols).toEqual([[60, 120], [5, null], [4, null], [1, null]])
  })
})

describe('parseDepthSeries', () => {
  it('shows ready only by default, and nothing for an empty param', () => {
    expect(parseDepthSeries(null)).toEqual(['ready'])
    expect(parseDepthSeries('')).toEqual([])
  })

  it('keeps known series and drops the rest', () => {
    expect(parseDepthSeries('ready, failed,bogus')).toEqual(['ready', 'failed'])
  })
})

describe('metricsRedirectSearch', () => {
  it('carries a range that is an interval, the series, the aggregate and the database', () => {
    const search = metricsRedirectSearch(new URLSearchParams('range=6h&series=ready,failed&agg=avg&db=two&w=900'))
    expect(new URLSearchParams(search)).toEqual(new URLSearchParams('interval=6h&series=ready,failed&agg=avg&db=two'))
  })

  it('drops a range with no interval, and custom bounds', () => {
    expect(metricsRedirectSearch(new URLSearchParams('range=7d'))).toBe('')
    expect(metricsRedirectSearch(new URLSearchParams('range=custom&from=2026-01-01&to=2026-01-02'))).toBe('')
  })
})

describe('downsample', () => {
  it('never merges across the windows, however few the points', () => {
    expect(downsample([point(0), point(60)], 1)).toHaveLength(2)
    expect(downsample([point(0), point(60), point(120), point(180)], 1)).toHaveLength(2)
  })

  it('merges buckets so no point spans both windows', () => {
    const points = Array.from({ length: 120 }, (_, i) => point(i * 60, { arrivedPerMin: i < 60 ? 1 : 2 }))
    const out = downsample(points, 48)
    expect(out).toHaveLength(40)
    expect(out.slice(0, 20).every((p) => p.arrivedPerMin === 1)).toBe(true)
    expect(out.slice(20).every((p) => p.arrivedPerMin === 2)).toBe(true)
  })

  it('averages what was counted, keeps the last ready count, and leaves an empty group null', () => {
    const out = downsample([
      point(0, { arrivedPerMin: 4, readyCount: 1 }),
      point(60, { arrivedPerMin: null, readyCount: 7 }),
      point(120),
      point(180),
    ], 2)
    expect(out).toEqual([
      point(0, { arrivedPerMin: 4, completedPerMin: null, failedPerMin: null, readyCount: 7 }),
      point(120),
    ])
  })
})

describe('queueSummaries', () => {
  it('gives every queue a tile with its current rates and share, busiest first', () => {
    const now = new Date('2026-09-28T12:00:30Z')
    const windows = statsWindows('1h', now)
    const t = seconds(windows.current.from)
    const tiles = queueSummaries(['quiet', 'small', 'big'], [
      { name: 'big', points: [point(t, { arrivedPerMin: 30, completedPerMin: 20, failedPerMin: 5 })] },
      { name: 'small', points: [point(t, { arrivedPerMin: 10 })] },
    ], '1h', windows)

    expect(tiles.map((q) => q.name)).toEqual(['big', 'small', 'quiet'])
    expect(tiles[0]).toMatchObject({ interval: '1h', bucketSeconds: 180 })
    expect(tiles[0]).toMatchObject({ arrivedPerMin: 30, finishingPerMin: 25, share: 0.75 })
    expect(tiles[2]).toMatchObject({ arrivedPerMin: null, finishingPerMin: null, share: 0 })
    expect(tiles[0].points).toHaveLength(40)
  })
})

describe('latency', () => {
  const bins = (slot: number, n: number) => Array.from({ length: LATENCY_SLOTS }, (_, i) => (i === slot ? n : 0))

  it('adds histograms slot by slot, and keeps one when the other is missing', () => {
    expect(addBins(bins(3, 2), bins(3, 1))?.[3]).toBe(3)
    expect(addBins(null, bins(5, 1))?.[5]).toBe(1)
    expect(addBins(bins(5, 1), undefined)?.[5]).toBe(1)
    expect(addBins(null, null)).toBeNull()
  })

  it('sums each window\'s histograms and keeps the newest oldest-ready wait', () => {
    const windows = statsWindows('1h', new Date('2026-09-28T12:00:30Z'))
    const prev = seconds(windows.previous.from)
    const cur = seconds(windows.current.from)
    const summary = latencySummary([
      point(prev, { waitBins: bins(10, 1), readyOldestSeconds: 90 }),
      point(cur, { waitBins: bins(10, 2), runBins: bins(4, 2), readyOldestSeconds: 30 }),
      point(cur + 60, { waitBins: bins(12, 1), readyOldestSeconds: 5 }),
    ], windows)

    expect(summary.previous.waitBins?.[10]).toBe(1)
    expect(summary.previous.runBins).toBeNull()
    expect(summary.current.waitBins?.[10]).toBe(2)
    expect(summary.current.waitBins?.[12]).toBe(1)
    expect(summary.readyOldestSeconds).toBe(5)
  })

  it('adds every queue\'s histograms for the all-queues series, and keeps the worst oldest wait', () => {
    const [summed] = sumSeries([
      { name: 'a', points: [point(60, { waitBins: bins(1, 1), readyOldestSeconds: 20 })] },
      { name: 'b', points: [point(60, { waitBins: bins(1, 2), readyOldestSeconds: 50 })] },
    ])
    expect(summed.waitBins?.[1]).toBe(3)
    expect(summed.readyOldestSeconds).toBe(50)
  })

  it('leaves the histograms off a tile\'s points, which carry them per window instead', () => {
    const [p] = downsample([point(0, { waitBins: bins(1, 1), readyOldestSeconds: 7 }), point(60, { readyOldestSeconds: 9 }), point(120), point(180)], 2)
    expect(p.waitBins).toBeUndefined()
    expect(p.readyOldestSeconds).toBe(9)
  })

  it('gives a tile its latency only when the database records it', () => {
    const windows = statsWindows('1h', new Date('2026-09-28T12:00:30Z'))
    const series = [{ name: 'a', points: [point(seconds(windows.current.from), { waitBins: bins(8, 4) })] }]
    expect(queueSummaries(['a'], series, '1h', windows)[0].latency).toBeNull()
    expect(queueSummaries(['a'], series, '1h', windows, true)[0].latency?.current.waitBins?.[8]).toBe(4)
  })
})
