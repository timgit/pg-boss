import assert from 'node:assert'
import { LATENCY_MIN_SECONDS } from './plans.ts'

type Bins = number[] | null | undefined

function total (bins: number[]): number {
  return bins.reduce((sum, n) => sum + n, 0)
}

/**
 * Combines two wait or run histograms into one by adding their counts bin by bin, as if all their
 * jobs had been recorded together. A null histogram counts as empty; null only when both are.
 * @see https://pgboss.io/api/utils#addbins-a-b
 */
export function addBins (a: Bins, b: Bins): number[] | null {
  if (!b) return a ? [...a] : null
  if (!a) return [...b]
  return a.map((n, i) => n + (b[i] ?? 0))
}

/**
 * The time in seconds below which a fraction `p` (0 to 1) of a wait or run histogram's jobs fall,
 * estimated within its bin. Null for an empty histogram.
 * @see https://pgboss.io/api/utils#percentile-bins-p
 */
export function percentile (bins: Bins, p: number): number | null {
  assert(p >= 0 && p <= 1, 'percentile: p must be between 0 and 1')
  if (!bins) return null

  const n = total(bins)
  if (n === 0) return null

  // Walk to the slot holding the target job. A valid histogram always reaches it; the last slot
  // stops the walk regardless, so counts that do not add up cannot run past the end.
  const target = p * n
  let k = 0
  let seen = 0
  while (k < bins.length - 1 && !(bins[k] > 0 && seen + bins[k] >= target)) seen += bins[k++]

  // Slot 0 has no lower edge, so a percentile in it is only known to be under 10 ms. The last slot
  // has no upper edge, so a percentile in it is only known to be past its lower edge.
  if (k === 0) return LATENCY_MIN_SECONDS
  const lo = LATENCY_MIN_SECONDS * Math.SQRT2 ** (k - 1)
  if (k === bins.length - 1) return lo
  return lo * Math.SQRT2 ** ((target - seen) / bins[k])
}
