import { type ReactNode } from 'react'
import { ParentLink, type Parent } from '~/components/parent-link'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  /** On a detail page, the page one level up, linked above the title. */
  parent?: Parent
  /** Beside the title, outside the heading, such as a badge. */
  badge?: ReactNode
}

// Route header — title + optional subtitle on the left, a primary action on
// the right. Leads every console view.
export function PageHeader ({ title, subtitle, action, parent, badge }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        {parent && <div className="mb-1.5 flex"><ParentLink {...parent} /></div>}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
            {title}
          </h1>
          {badge}
        </div>
        {subtitle && (
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  )
}
