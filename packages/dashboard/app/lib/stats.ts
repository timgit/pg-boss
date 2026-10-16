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

/**
 * Running sums across series, point by point, for a stacked chart: the first series as it is, each
 * next one added to the sum below it. A missing value stays missing and adds nothing.
 */
export function stackSeries (series: ReadonlyArray<ArrayLike<number | null | undefined>>): Array<Array<number | null>> {
  const length = series.reduce((n, s) => Math.max(n, s.length), 0)
  const sums = new Array<number>(length).fill(0)
  return series.map((s) =>
    Array.from({ length }, (_, i) => {
      const v = s[i]
      if (v == null) return null
      sums[i] += v
      return sums[i]
    })
  )
}
