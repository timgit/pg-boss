import { useSearchParams } from 'react-router'
import type { Route } from './+types/warnings'
import { getWarnings, getWarningCount } from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
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
import { TablePagination } from '~/components/table-pagination'
import { pageWindow, pageInfo } from '~/lib/pagination'
import { FilterSelect } from '~/components/ui/filter-select'
import { ErrorCard } from '~/components/error-card'
import type { WarningType, WarningResult } from '~/lib/types'
import {
  isValidWarningType,
  formatDateWithSeconds,
  formatWarningData,
  WARNING_TYPE_OPTIONS,
  warningTypeVariant,
  warningTypeLabel,
} from '~/lib/utils'
import { dbContext } from '~/lib/db-context'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Warnings' }

const PAGE_SIZE = 50

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const typeParam = url.searchParams.get('type')

  // Validate warning type filter - invalid values are treated as no filter
  const typeFilter = isValidWarningType(typeParam) ? typeParam : null

  const { page, limit, offset } = pageWindow(url, PAGE_SIZE)
  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')

  const [warnings, totalCount] = await Promise.all([
    getWarnings(DB_URL, SCHEMA, {
      type: typeFilter,
      limit,
      offset,
      sort,
      dir,
    }),
    getWarningCount(DB_URL, SCHEMA, typeFilter),
  ])

  return {
    warnings,
    totalCount,
    typeFilter,
    pageSize: PAGE_SIZE,
    ...pageInfo(page, PAGE_SIZE, warnings.length, totalCount),
  }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return (
    <ErrorCard
      title="Failed to load warnings"
      error={error}
      backTo={{ href: '/', label: 'Back to Dashboard' }}
    />
  )
}

export default function Warnings ({ loaderData }: Route.ComponentProps) {
  const { warnings, totalCount, typeFilter, pageSize, page, totalPages, hasNextPage, hasPrevPage } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()

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


  return (
    <div className="space-y-4">
      <PageHeader
        title="Warnings"
        subtitle={`${totalCount.toLocaleString()} warning${totalCount !== 1 ? 's' : ''} recorded · events emitted while persistWarnings is enabled`}
      />

      <Card>
        <CardHeader>
          <CardTitle>Event log</CardTitle>
          <FilterSelect
            value={typeFilter}
            options={WARNING_TYPE_OPTIONS}
            onChange={(value) => handleFilterChange('type', value)}
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader column="type">Type</SortableHeader>
                <TableHead>Message</TableHead>
                <TableHead>Details</TableHead>
                <SortableHeader column="created">Time</SortableHeader>
              </TableRow>
            </TableHeader>
            <TableBody>
              {warnings.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={4}>
                    {typeFilter
                      ? `No ${typeFilter.replace('_', ' ')} warnings found`
                      : 'No warnings recorded. Enable persistWarnings in pg-boss config to capture warnings.'}
                  </TableCell>
                </TableRow>
              ) : (
                warnings.map((warning: WarningResult) => (
                  <TableRow key={warning.id}>
                    <TableCell>
                      <WarningTypeBadge type={warning.type} />
                    </TableCell>
                    <TableCell className="text-[var(--text-primary)] max-w-md truncate">
                      {warning.message}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-[var(--text-tertiary)] max-w-xs truncate">
                      {formatWarningData(warning.data)}
                    </TableCell>
                    <TableCell className="pgb-num text-[var(--text-tertiary)] whitespace-nowrap">
                      {formatDateWithSeconds(new Date(warning.createdOn))}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <TablePagination
          page={page}
          totalPages={totalPages}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
          totalCount={totalCount}
          pageSize={pageSize}
        />
      </Card>
    </div>
  )
}

function WarningTypeBadge ({ type }: { type: WarningType }) {
  return (
    <Badge variant={warningTypeVariant(type)} size="sm" dot>
      {warningTypeLabel(type)}
    </Badge>
  )
}
