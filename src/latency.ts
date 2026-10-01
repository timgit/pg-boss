import assert from 'node:assert'
import { LATENCY_MIN_SECONDS } from './plans.ts'

type Bins = number[] | null | undefined

function total (bins: number[]): number {
  return bins.reduce((sum, n) => sum + n, 0)
}

/**
 * Adds two wait or run histograms slot by slot, so a percentile can be read over several snapshots
 * or queues. Null when both are null.
 * @see https://pgboss.io/api/utils#addbins-a-b
 */
export function addBins (a: Bins, b: Bins): number[] | null {
  if (!b) return a ? [...a] : null
  if (!a) return [...b]
  return a.map((n, i) => n + (b[i] ?? 0))
}

/**
 * The time in seconds below which a fraction `p` (0 to 1) of a wait or run histogram's jobs fall,
 * read within its slot on the log scale. Null for an empty histogram.
 * @see https://pgboss.io/api/utils#percentile-bins-p
 */
export function percentile (bins: Bins, p: number): number | null {
  assert(p >= 0 && p <= 1, 'percentile: p must be between 0 and 1')
  if (!bins) return null

  const n = total(bins)
  if (n === 0) return null

  // Slot 0 has no lower edge, so a percentile in it is only known to be under 10 ms. The last slot
  // has no upper edge, so a percentile in it is only known to be past its lower edge.
  const target = p * n
  let seen = 0
  for (let k = 0; k < bins.length; k++) {
    const count = bins[k]
    if (count > 0 && seen + count >= target) {
      if (k === 0) return LATENCY_MIN_SECONDS
      const lo = LATENCY_MIN_SECONDS * Math.SQRT2 ** (k - 1)
      if (k === bins.length - 1) return lo
      return lo * Math.SQRT2 ** ((target - seen) / count)
    }
    seen += count
  }
  return null
}
