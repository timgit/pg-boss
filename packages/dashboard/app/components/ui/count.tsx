import { formatCompact, formatFull } from '~/lib/format'

/** A count abbreviated to fit a figure, with the full number on hover when it was shortened. */
export function Count ({ value }: { value: number }) {
  const short = formatCompact(value)
  const full = formatFull(value)
  return <span title={short === full ? undefined : full}>{short}</span>
}
