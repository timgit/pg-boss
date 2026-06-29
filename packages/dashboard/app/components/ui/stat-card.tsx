import { type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { DbLink } from '~/components/db-link'

type StatAccent = 'neutral' | 'primary' | 'success' | 'warning' | 'error'

interface StatCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  accent?: StatAccent
  /** Optional trend visualization (e.g. a <Sparkline />) rendered beneath the value. */
  sparkline?: ReactNode
  /** When set, the whole card becomes a (db-aware) link to this path, with a hover affordance. */
  to?: string
  className?: string
}

// Metric tile — uppercase eyebrow label, large tabular-mono value, optional
// hint. The four-up StatCard row leads every top-level list view.
const accentText: Record<StatAccent, string> = {
  neutral: 'text-gray-900 dark:text-gray-100',
  primary: 'text-primary-600 dark:text-primary-400',
  success: 'text-[var(--success-600)]',
  warning: 'text-[var(--warning-600)]',
  error: 'text-[var(--error-600)]',
}

export function StatCard ({ label, value, hint, accent = 'neutral', sparkline, to, className }: StatCardProps) {
  const card = (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border border-[var(--border-default)] p-4 shadow-sm',
        // h-full so the card fills the link wrapper (which becomes the grid item when `to` is set).
        to && 'h-full transition-colors hover:border-[var(--border-strong)] hover:shadow-md',
        className
      )}
      style={{ background: 'var(--surface-card-grad)' }}
    >
      <span className="pgb-eyebrow">{label}</span>
      <span
        className={cn(
          'pgb-num text-3xl font-medium leading-none tracking-tight',
          accentText[accent]
        )}
      >
        {value}
      </span>
      {sparkline && <div className="mt-0.5 h-6">{sparkline}</div>}
      {hint && <span className="text-xs text-[var(--text-tertiary)]">{hint}</span>}
    </div>
  )

  if (!to) return card

  return (
    <DbLink to={to} className="block" aria-label={`View ${label} metrics`}>
      {card}
    </DbLink>
  )
}
