import { type ReactNode } from 'react'
import { cn } from '~/lib/utils'

type StatAccent = 'neutral' | 'primary' | 'success' | 'warning' | 'error'

interface StatCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  accent?: StatAccent
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

export function StatCard ({ label, value, hint, accent = 'neutral', className }: StatCardProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border border-[var(--border-default)] p-4 shadow-sm',
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
      {hint && <span className="text-xs text-[var(--text-tertiary)]">{hint}</span>}
    </div>
  )
}
