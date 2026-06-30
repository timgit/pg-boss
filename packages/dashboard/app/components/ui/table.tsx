import { type ReactNode, type MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { cn } from '~/lib/utils'
import { useDbHref } from '~/components/db-link'

interface TableProps {
  children: ReactNode
  className?: string
}

interface TableHeaderProps {
  children: ReactNode
  className?: string
}

interface TableBodyProps {
  children: ReactNode
  className?: string
}

interface TableRowProps {
  children: ReactNode
  className?: string
  onClick?: () => void
  /**
   * When set, the whole row becomes clickable and navigates here (preserving the db selection).
   * Clicks on nested interactive elements (links, buttons, inputs, menus) are left to them, and
   * modifier/middle clicks fall through so the row's primary link can still open in a new tab.
   */
  to?: string
}

// Descendants that handle their own click — a row-level navigation must not hijack these.
const ROW_INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="menuitem"], [data-no-row-nav]'

interface TableHeadProps {
  children: ReactNode
  className?: string
}

interface TableCellProps {
  children: ReactNode
  className?: string
  colSpan?: number
}

export function Table ({ children, className }: TableProps) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="min-w-full border-collapse">
        {children}
      </table>
    </div>
  )
}

export function TableHeader ({ children, className }: TableHeaderProps) {
  return (
    <thead className={cn('bg-[var(--surface-sunken)]', className)}>
      {children}
    </thead>
  )
}

export function TableBody ({ children, className }: TableBodyProps) {
  return (
    <tbody className={className}>
      {children}
    </tbody>
  )
}

export function TableRow ({ children, className, onClick, to }: TableRowProps) {
  const navigate = useNavigate()
  // Hooks must run unconditionally; the resolved href is only used when `to` is set.
  const href = useDbHref(to ?? '')
  const clickable = Boolean(to || onClick)

  const handleClick = (event: MouseEvent<HTMLTableRowElement>) => {
    onClick?.()
    if (!to) return
    // Let the browser/inner element handle new-tab/window and modified clicks.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    // Defer to nested interactive elements so they keep their own behavior.
    if ((event.target as HTMLElement).closest(ROW_INTERACTIVE_SELECTOR)) return
    navigate(href)
  }

  return (
    <tr
      className={cn(
        'border-b border-[var(--border-subtle)]',
        clickable && 'cursor-pointer hover:bg-[var(--surface-hover)] transition-colors',
        className
      )}
      onClick={clickable ? handleClick : undefined}
    >
      {children}
    </tr>
  )
}

export function TableHead ({ children, className }: TableHeadProps) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-2.5 align-middle text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)] whitespace-nowrap',
        className
      )}
    >
      {/* Mirror SortableHeader's button: inline-flex + align-middle so every header — plain or
          sortable, left or right — positions by box center rather than a (direction-dependent)
          baseline, keeping them all vertically aligned. */}
      <span className="inline-flex items-center align-middle">{children}</span>
    </th>
  )
}

export function TableCell ({ children, className, colSpan }: TableCellProps) {
  return (
    <td
      className={cn('px-4 py-2.5 whitespace-nowrap text-sm text-[var(--text-secondary)]', className)}
      colSpan={colSpan}
    >
      {children}
    </td>
  )
}

interface SortableHeaderProps {
  /** Sort key — written to the `sort` URL param and matched against the query's allowlist. */
  column: string
  children: ReactNode
  /** Full human-readable name for the tooltip + aria-label when `children` is an abbreviation. */
  title?: string
  align?: 'left' | 'right'
  className?: string
}

// A clickable column header that drives server-side sorting through the URL (`?sort=&dir=`).
// Clicking an inactive column sorts ascending; clicking the active column toggles asc/desc. The
// direction arrow shows only on the active column and on hover (its slot is reserved so columns
// don't shift). Pass `title` when the visible label is an abbreviation. Sorting resets to page 1.
export function SortableHeader ({ column, children, title, align = 'left', className }: SortableHeaderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeSort = searchParams.get('sort')
  const activeDir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
  const isActive = activeSort === column

  const handleClick = () => {
    const params = new URLSearchParams(searchParams)
    params.set('sort', column)
    params.set('dir', isActive && activeDir === 'asc' ? 'desc' : 'asc')
    params.delete('page')
    setSearchParams(params)
  }

  const label = title ?? (typeof children === 'string' ? children : column)
  const Icon = isActive ? (activeDir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown

  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-2.5 align-middle text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)] whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left',
        className
      )}
    >
      <button
        type="button"
        onClick={handleClick}
        title={title}
        aria-label={`Sort by ${label}`}
        className={cn(
          // align-middle positions the button by its box center (not its baseline, which
          // flex-row-reverse would otherwise shift), so left/right headers line up vertically.
          'group inline-flex items-center align-middle gap-1 uppercase cursor-pointer transition-colors hover:text-[var(--text-secondary)]',
          isActive && 'text-[var(--text-secondary)]',
          align === 'right' && 'flex-row-reverse'
        )}
      >
        <span>{children}</span>
        <Icon
          className={cn(
            'h-3 w-3 shrink-0 transition-opacity',
            isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
          )}
          aria-hidden="true"
        />
      </button>
    </th>
  )
}
