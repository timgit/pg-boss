import { DbLink } from '~/components/db-link'
import { Badge } from '~/components/ui/badge'
import { TableCell } from '~/components/ui/table'
import type { JobResult } from '~/lib/types'
import {
  formatDate,
  JOB_STATE_VARIANTS,
} from '~/lib/utils'
import {
  getRowCellValue,
  type JobColumn,
} from '~/lib/job-columns'

export function JobColumnCell ({
  row,
  column,
  queueName = row.name,
}: {
  row: JobResult
  column: JobColumn
  queueName?: string
}) {
  switch (column.path) {
    case 'id':
      return (
        <TableCell>
          <DbLink
            to={`/queues/${encodeURIComponent(queueName)}/jobs/${row.id}`}
            className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
          >
            {row.id}
          </DbLink>
        </TableCell>
      )
    case 'name':
      return (
        <TableCell className="font-medium text-[var(--text-secondary)]">
          {row.name}
        </TableCell>
      )
    case 'state':
      return (
        <TableCell>
          <Badge variant={JOB_STATE_VARIANTS[row.state]} size="sm" dot>
            {row.state}
          </Badge>
        </TableCell>
      )
    case 'retries':
      return (
        <TableCell className="pgb-num text-[var(--text-primary)]">
          {row.retryCount} / {row.retryLimit}
        </TableCell>
      )
    case 'priority':
    case 'retryCount':
    case 'retryLimit':
      return (
        <TableCell className="pgb-num text-[var(--text-primary)]">
          {row[column.path]}
        </TableCell>
      )
    case 'createdOn':
    case 'startedOn':
    case 'completedOn':
    case 'startAfter': {
      const value = row[column.path]
      return (
        <TableCell className="pgb-num text-[var(--text-tertiary)]">
          {value ? formatDate(new Date(value)) : '—'}
        </TableCell>
      )
    }
    default: {
      const value = getRowCellValue(row, column.path)
      return (
        <TableCell className="font-mono text-xs text-[var(--text-secondary)] max-w-[12rem] truncate">
          <span title={value ?? undefined}>{value ?? '—'}</span>
        </TableCell>
      )
    }
  }
}
