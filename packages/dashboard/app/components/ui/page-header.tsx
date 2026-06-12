import { type ReactNode } from 'react'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
}

// Route header — title + optional subtitle on the left, a primary action on
// the right. Leads every console view.
export function PageHeader ({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  )
}
