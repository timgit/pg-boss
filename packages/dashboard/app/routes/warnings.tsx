import { useSearchParams } from 'react-router'
import type { Route } from './+types/warnings'
import { getWarnings } from '~/lib/queries.server'
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
import { FilterSelect } from '~/components/ui/filter-select'
import { ErrorCard } from '~/components/error-card'
import type { WarningType, WarningResult } from '~/lib/types'
import {
  parsePaging,
  resetPaging,
  isValidWarningType,
  formatDateWithSeconds,
  formatWarningData,
  WARNING_TYPE_OPTIONS,
  warningTypeVariant,
  warningTypeLabel,
} from '~/lib/utils'
import { dbContext } from '~/lib/db-context'
import type { TitleHandle } from '~/lib/page-title'
import { PAGE_SIZE } from '~/lib/pagination'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Warnings' }


export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const typeParam = url.searchParams.get('type')

  // Validate warning type filter - invalid values are treated as no filter
  const typeFilter = isValidWarningType(typeParam) ? typeParam : null

  const { page, cursor } = parsePaging(url.searchParams)
  const limit = PAGE_SIZE
  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')

  // No count: the warning table grows for as long as warnings are kept, so a page reads one past its end to offer Next.
  const warnings = await getWarnings(DB_URL, SCHEMA, {
    type: typeFilter,
    limit,
    cursor,
    sort,
    dir,
  })

  return {
    warnings: warnings.rows,
    page: warnings.atStart ? 1 : page,
    hasNextPage: warnings.hasNextPage,
    hasPrevPage: warnings.hasPrevPage,
    nextCursor: warnings.nextCursor,
    prevCursor: warnings.prevCursor,
    typeFilter,
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
  const { warnings, typeFilter, page, hasNextPage, hasPrevPage } = loaderData
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
        title="Warnings"
        subtitle="Events emitted while persistWarnings is enabled, newest first"
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
                      : 'No warnings recorded. Enable persistWarnings in your config to capture warnings.'}
                  </TableCell>
                </TableRow>
              ) : (
                warnings.map((warning: WarningResult) => (
                  <TableRow key={warning.id} to={`/warnings/${warning.id}`}>
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
          nextCursor={loaderData.nextCursor}
          prevCursor={loaderData.prevCursor}
          totalPages={null}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
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
