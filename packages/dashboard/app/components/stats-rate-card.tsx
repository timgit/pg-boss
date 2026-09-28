import { Sparkline } from '~/components/ui/sparkline'
import { percentChange } from '~/lib/stats'
import { cn } from '~/lib/utils'

interface StatsRateCardProps {
  label: string
  /** CSS color of the series, shown as a key beside the label and as the sparkline stroke. */
  color: string
  /** Average jobs per minute in the current window, null when nothing was counted. */
  current: number | null
  previous: number | null
  /**
   * How to colour the change. A rise in arrivals is neither good nor bad by itself; a fall in
   * finishing is bad and a rise good.
   */
  tone: 'neutral' | 'higher-is-better'
  /** "hour", "6 hours", "24 hours": what the comparison is against. */
  noun: string
  /** Per-bucket rates across both windows, the previous window first. */
  series: Array<number | null>
}

export function formatRate (perMin: number): string {
  if (perMin === 0) return '0'
  if (perMin >= 100) return Math.round(perMin).toLocaleString('en-US')
  if (perMin >= 10) return perMin.toFixed(0)
  return perMin.toFixed(1)
}

// Inside this band a change reads as flat, so the card does not flicker between up and down.
const FLAT = 0.03

function Change ({ current, previous, tone, noun }: Pick<StatsRateCardProps, 'current' | 'previous' | 'tone' | 'noun'>) {
  const vs = <span className="text-[var(--text-tertiary)]">vs previous {noun}</span>
  const change = percentChange(current, previous)

  if (change == null) {
    const when = current == null ? `in the last ${noun}` : `for the ${noun} before`
    return <span className="text-[var(--text-tertiary)]">No rate {when}</span>
  }
  if (Math.abs(change) < FLAT) {
    return <span><span className="pgb-num text-[var(--text-tertiary)]">≈ 0%</span> {vs}</span>
  }

  const up = change > 0
  const text = change === Infinity ? 'up from zero' : `${up ? '+' : '−'}${Math.abs(Math.round(change * 100))}%`
  const color = tone === 'neutral'
    ? 'text-[var(--text-primary)]'
    : up ? 'text-[var(--success-600)]' : 'text-[var(--error-600)]'

  return (
    <span>
      <span className={cn('pgb-num font-medium', color)}>
        <span aria-hidden="true">{up ? '▲' : '▼'} </span>{text}
      </span>{' '}
      {vs}
    </span>
  )
}

// One rate KPI on /stats: the current window's average per minute, its change against the
// previous window, and a sparkline across both with the previous half shaded.
export function StatsRateCard ({ label, color, current, previous, tone, noun, series }: StatsRateCardProps) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[10px] border border-[var(--border-default)] p-4 shadow-sm"
      style={{ background: 'var(--surface-card-grad)' }}
    >
      <span className="pgb-eyebrow flex items-center gap-2">
        <span aria-hidden="true" className="inline-block h-0.5 w-2.5 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="pgb-num text-3xl font-medium leading-none tracking-tight text-[var(--text-primary)]">
        {current == null ? '—' : formatRate(current)}
        <span className="ml-1 text-sm font-normal tracking-normal text-[var(--text-tertiary)]">/min</span>
      </span>
      <span className="text-[13px]">
        <Change current={current} previous={previous} tone={tone} noun={noun} />
      </span>
      <div className="mt-0.5 h-8">
        <Sparkline
          data={series}
          width={320}
          height={32}
          color={color}
          showDot={false}
          zeroBased
          shadeTo={0.5}
          stretch
          aria-label={`${label} over the previous and current ${noun}`}
        />
      </div>
    </div>
  )
}
