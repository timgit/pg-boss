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
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
        {children}
      </table>
    </div>
  )
}

export function TableHeader ({ children, className }: TableHeaderProps) {
  return (
    <thead className={cn('bg-gray-50 dark:bg-gray-900', className)}>
      {children}
    </thead>
  )
}

export function TableBody ({ children, className }: TableBodyProps) {
  return (
    <tbody
      className={cn(
        'divide-y divide-gray-200 bg-white',
        'dark:divide-gray-800 dark:bg-gray-950',
        className
      )}
    >
      {children}
    </tbody>
  )
}

export function TableRow ({ children, className, onClick }: TableRowProps) {
  return (
    <tr
      className={cn(
        onClick && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors',
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
        'px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider',
        'dark:text-gray-400',
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
      className={cn('px-6 py-4 whitespace-nowrap text-sm', className)}
      colSpan={colSpan}
    >
      {children}
    </td>
  )
}
