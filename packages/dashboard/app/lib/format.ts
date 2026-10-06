/** Counts up to this many are written in full; larger ones are abbreviated. */
const COMPACT_FROM = 10_000

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/**
 * A count short enough for a figure or a card: in full with separators below 10,000, then 12.3K,
 * 4.5M, 1.2B. Tables, where a column can widen, keep full digits.
 */
export function formatCompact (value: number): string {
  return Math.abs(value) < COMPACT_FROM ? Math.round(value).toLocaleString('en-US') : compact.format(value)
}

/** A count in full, with separators. */
export function formatFull (value: number): string {
  return value.toLocaleString('en-US')
}
