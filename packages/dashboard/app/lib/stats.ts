// Wait and run times as pg-boss 12.36 (schema v44) records them: 48 counts per histogram, slot 0
// under 10 ms, then bins √2 wide up to about 23 hours, the last slot beyond. Histograms add slot by
// slot, so a span or a set of queues is summed first and any percentile is read from the sum.
export const LATENCY_SLOTS = 48

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
