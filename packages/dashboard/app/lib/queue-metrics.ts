import type { QueueStatsPoint } from './types'

/** Each point's queued count split by why the jobs wait, one array per series, in point order. */
export interface WaitingBreakdown {
  ready: number[]
  blocked: number[]
  deferred: number[]
  queued: number[]
}

/**
 * Splits each point's Queued into Ready, Blocked by a flow parent and Deferred. Blocked is what
 * Queued leaves after Ready and Deferred, never below zero.
 */
export function waitingBreakdown (points: QueueStatsPoint[]): WaitingBreakdown {
  const out: WaitingBreakdown = { ready: [], blocked: [], deferred: [], queued: [] }
  for (const p of points) {
    out.ready.push(p.readyCount)
    out.deferred.push(p.deferredCount)
    out.queued.push(p.queuedCount)
    // Each count is aggregated over its bucket on its own, so with max or min the three need not
    // come from the same pass and can add up to more than Queued.
    out.blocked.push(Math.max(0, p.queuedCount - p.readyCount - p.deferredCount))
  }
  return out
}
