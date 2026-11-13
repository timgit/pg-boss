import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'

/** A text field or text area on the dashboard's forms. */
export const inputClass = cn(
  'w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] px-3 py-2 text-sm',
  'text-[var(--text-primary)] placeholder-[var(--text-tertiary)]',
  'focus:border-[var(--border-focus)] focus:shadow-[var(--shadow-focus)] focus:outline-none'
)

const labelClass = 'mb-1 block text-sm font-medium text-[var(--text-secondary)]'

/** A labeled form field, with a hint under it when one is given. */
export function Field ({ id, label, hint, children }: { id: string, label: string, hint?: string, children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  )
}
