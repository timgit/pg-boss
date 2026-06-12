import { type ReactNode } from 'react'
import { cn } from '~/lib/utils'

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
}

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

export function TableRow ({ children, className, onClick }: TableRowProps) {
  return (
    <tr
      className={cn(
        'border-b border-[var(--border-subtle)]',
        onClick && 'cursor-pointer hover:bg-[var(--surface-hover)] transition-colors',
        className
      )}
      onClick={onClick}
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
        'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)] whitespace-nowrap',
        className
      )}
    >
      {children}
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
