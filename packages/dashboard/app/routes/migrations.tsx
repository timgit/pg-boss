import { DbLink } from '~/components/db-link'
import { useSearchParams } from 'react-router'
import type { Route } from './+types/migrations'
import { getBamEntries, getBamCount } from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  SortableHeader,
} from '~/components/ui/table'
import { FilterSelect } from '~/components/ui/filter-select'
import { TablePagination } from '~/components/table-pagination'
import { ErrorCard } from '~/components/error-card'
import type { BamEntryResult } from '~/lib/types'
import {
  parsePaging,
  resetPaging,
  isValidBamStatus,
  formatDateWithSeconds,
  BAM_STATUS_OPTIONS,
  BAM_STATUS_VARIANTS,
  BAM_STATUS_LABELS,
} from '~/lib/utils'
import { dbContext } from '~/lib/db-context'
import type { TitleHandle } from '~/lib/page-title'
import { PAGE_SIZE } from '~/lib/pagination'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Migrations' }


export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status')

  // Validate status filter - invalid values are treated as no filter
  const statusFilter = isValidBamStatus(statusParam) ? statusParam : null

  const { page, cursor } = parsePaging(url.searchParams)
  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')

  const [entries, totalCount] = await Promise.all([
    getBamEntries(DB_URL, SCHEMA, { status: statusFilter, limit: PAGE_SIZE, cursor, sort, dir }),
    getBamCount(DB_URL, SCHEMA, statusFilter),
  ])

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  return {
    entries: entries.rows,
    statusFilter,
    totalCount,
    page: entries.atStart ? 1 : page,
    totalPages,
    hasNextPage: entries.hasNextPage,
    hasPrevPage: entries.hasPrevPage,
    nextCursor: entries.nextCursor,
    prevCursor: entries.prevCursor,
  }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return (
    <ErrorCard
      title="Failed to load migrations"
      error={error}
      backTo={{ href: '/', label: 'Back to Dashboard' }}
    />
  )
}

export default function Migrations ({ loaderData }: Route.ComponentProps) {
  const { entries, statusFilter, totalCount, page, totalPages, hasNextPage, hasPrevPage } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()

  const handleFilterChange = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (value) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    resetPaging(params)
    setSearchParams(params)
  }


  return (
    <div className="space-y-4">
      <PageHeader
        title="Migrations"
        subtitle="Boss async migrations (BAM), the schema changes such as concurrent index builds that run outside the install transaction"
      />

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
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={7}>
                    {statusFilter
                      ? `No ${BAM_STATUS_LABELS[statusFilter].toLowerCase()} migrations found`
                      : 'No async migrations recorded.'}
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry: BamEntryResult) => (
                  <TableRow key={entry.id} to={`/migrations/${entry.id}`}>
                    <TableCell className="font-medium">
                      <DbLink to={`/migrations/${entry.id}`} className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300">
                        {entry.name}
                      </DbLink>
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
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <TablePagination
          page={page}
          nextCursor={loaderData.nextCursor}
          prevCursor={loaderData.prevCursor}
          totalPages={totalPages}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
          totalCount={totalCount}
          pageSize={PAGE_SIZE}
        />
      </Card>
    </div>
  )
}

function formatTimestamp (value: Date | null): string {
  if (!value) return '—'
  return formatDateWithSeconds(new Date(value))
}
