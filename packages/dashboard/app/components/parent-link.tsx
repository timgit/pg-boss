import { ChevronLeft } from 'lucide-react'
import { DbLink } from './db-link'

export interface Parent {
  to: string
  label: string
}

/**
 * The way up from a detail page, above its title: `‹ Queues` on a queue, `‹ demo-billing` on one of
 * its jobs. One level only; the sidebar reaches the sections and the browser's back button the rest.
 */
export function ParentLink ({ to, label }: Parent) {
  return (
    <DbLink
      to={to}
      className="inline-flex max-w-full items-center gap-1 self-start text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
    >
      <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </DbLink>
  )
}
