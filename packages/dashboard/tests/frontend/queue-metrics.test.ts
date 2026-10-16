import { describe, it, expect } from 'vitest'
import { waitingBreakdown } from '~/lib/queue-metrics'
import type { QueueStatsPoint } from '~/lib/types'

const point = (counts: Partial<QueueStatsPoint>): QueueStatsPoint => ({
  capturedOn: 0,
  deferredCount: 0,
  queuedCount: 0,
  readyCount: 0,
  activeCount: 0,
  failedCount: 0,
  totalCount: 0,
  ...counts,
})

describe('waitingBreakdown', () => {
  it('splits Queued into Ready, Blocked and Deferred', () => {
    const out = waitingBreakdown([
      point({ queuedCount: 10, readyCount: 6, deferredCount: 1 }),
      point({ queuedCount: 4, readyCount: 4, deferredCount: 0 }),
    ])
    expect(out).toEqual({ ready: [6, 4], blocked: [3, 0], deferred: [1, 0], queued: [10, 4] })
  })

  it('never puts Blocked below zero when the bucket counts overshoot Queued', () => {
    // max per column: Ready and Deferred can peak on different passes than Queued.
    const out = waitingBreakdown([point({ queuedCount: 5, readyCount: 4, deferredCount: 3 })])
    expect(out.blocked).toEqual([0])
  })

  it('is empty for no points', () => {
    expect(waitingBreakdown([])).toEqual({ ready: [], blocked: [], deferred: [], queued: [] })
  })
})
