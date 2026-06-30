import { useSearchParams } from 'react-router'
import type { Route } from './+types/migrations'
import { getBamEntries, getBamCount, getBamStatusSummary } from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { StatCard } from '~/components/ui/stat-card'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableHeader,
} from '~/components/ui/table'
import { FilterSelect } from '~/components/ui/filter-select'
import { Pagination } from '~/components/ui/pagination'
import { ErrorCard } from '~/components/error-card'
import type { BamEntryResult, BamStatus, BamStatusSummary } from '~/lib/types'
import {
  parsePageNumber,
  isValidBamStatus,
  formatDateWithSeconds,
  BAM_STATUSES,
  BAM_STATUS_OPTIONS,
  BAM_STATUS_VARIANTS,
  BAM_STATUS_LABELS,
} from '~/lib/utils'
import { dbContext } from '~/lib/db-context'

const PAGE_SIZE = 50

// Accent for the four summary tiles. pending/in_progress get attention colors
// since those are the actionable (incomplete) states.
const STATUS_ACCENT: Record<BamStatus, 'neutral' | 'primary' | 'success' | 'warning' | 'error'> = {
  pending: 'warning',
  in_progress: 'primary',
  completed: 'success',
  failed: 'error',
}

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status')

  // Validate status filter - invalid values are treated as no filter
  const statusFilter = isValidBamStatus(statusParam) ? statusParam : null

  const page = parsePageNumber(url.searchParams.get('page'))
  const offset = (page - 1) * PAGE_SIZE
  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')

  const [entries, totalCount, summary] = await Promise.all([
    getBamEntries(DB_URL, SCHEMA, { status: statusFilter, limit: PAGE_SIZE, offset, sort, dir }),
    getBamCount(DB_URL, SCHEMA, statusFilter),
    getBamStatusSummary(DB_URL, SCHEMA),
  ])

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  return { entries, summary, statusFilter, page, totalPages }
}

export function ErrorBoundary () {
  return (
    <ErrorCard
      title="Failed to load migrations"
      backTo={{ href: '/', label: 'Back to Dashboard' }}
    />
  )
}

export default function Migrations ({ loaderData }: Route.ComponentProps) {
  const { entries, summary, statusFilter, page, totalPages } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()

  const counts = countByStatus(summary)

  const handleFilterChange = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (value) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    params.delete('page')
    setSearchParams(params)
  }

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams)
    params.set('page', newPage.toString())
    setSearchParams(params)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Migrations"
        subtitle="Background async migrations (BAM) — schema changes such as concurrent index builds that run outside the install transaction"
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {BAM_STATUSES.map((status) => (
          <StatCard
            key={status}
            label={BAM_STATUS_LABELS[status]}
            value={counts[status].toLocaleString()}
            accent={counts[status] > 0 ? STATUS_ACCENT[status] : 'neutral'}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Migration commands</CardTitle>
          <FilterSelect
            value={statusFilter}
            options={BAM_STATUS_OPTIONS}
            onChange={(value) => handleFilterChange('status', value)}
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader column="name">Name</SortableHeader>
                <SortableHeader column="version" align="right">Ver</SortableHeader>
                <SortableHeader column="status">Status</SortableHeader>
                <SortableHeader column="table">Table</SortableHeader>
                <SortableHeader column="created">Created</SortableHeader>
                <SortableHeader column="started">Started</SortableHeader>
                <SortableHeader column="completed">Completed</SortableHeader>
                <TableHead>Command / Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={8}>
                    {statusFilter
                      ? `No ${BAM_STATUS_LABELS[statusFilter].toLowerCase()} migrations found`
                      : 'No async migrations recorded.'}
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry: BamEntryResult) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-[var(--text-primary)] font-medium">
                      {entry.name}
                    </TableCell>
                    <TableCell className="text-right pgb-num text-[var(--text-tertiary)]">
                      {entry.version}
                    </TableCell>
                    <TableCell>
                      <Badge variant={BAM_STATUS_VARIANTS[entry.status]} size="sm" dot>
                        {BAM_STATUS_LABELS[entry.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-[var(--text-secondary)] whitespace-nowrap">
                      {entry.table}
                      {entry.queue ? (
                        <span className="text-[var(--text-tertiary)]"> · {entry.queue}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="pgb-num text-[var(--text-tertiary)] whitespace-nowrap">
                      {formatTimestamp(entry.createdOn)}
                    </TableCell>
                    <TableCell className="pgb-num text-[var(--text-tertiary)] whitespace-nowrap">
                      {formatTimestamp(entry.startedOn)}
                    </TableCell>
                    <TableCell className="pgb-num text-[var(--text-tertiary)] whitespace-nowrap">
                      {formatTimestamp(entry.completedOn)}
                    </TableCell>
                    <TableCell className="max-w-md">
                      {entry.error ? (
                        <p className="mb-1 font-mono text-xs text-[var(--error-600)] break-words whitespace-pre-wrap">
                          {entry.error}
                        </p>
                      ) : null}
                      <details>
                        <summary className="cursor-pointer text-xs text-[var(--text-tertiary)] select-none">
                          View command
                        </summary>
                        <pre className="mt-1 overflow-x-auto rounded bg-[var(--surface-sunken)] p-2 font-mono text-xs text-[var(--text-secondary)] whitespace-pre-wrap">
                          {entry.command}
                        </pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <Pagination
          page={page}
          totalPages={totalPages}
          hasNextPage={page < totalPages}
          hasPrevPage={page > 1}
          onPageChange={handlePageChange}
        />
      </Card>
    </div>
  )
}

function formatTimestamp (value: Date | null): string {
  if (!value) return '—'
  return formatDateWithSeconds(new Date(value))
}

function countByStatus (summary: BamStatusSummary[]): Record<BamStatus, number> {
  const counts: Record<BamStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
  }
  for (const row of summary) {
    if (row.status in counts) counts[row.status] += row.count
  }
  return counts
}
