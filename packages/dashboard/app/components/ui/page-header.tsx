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
// the right. Leads every console view. On a phone the action goes under the title, which would
// otherwise share the width with it and wrap a word to a line.
export function PageHeader ({ title, subtitle, action, parent, badge }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
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
