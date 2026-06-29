import { useSearchParams } from 'react-router'
import { useState, useEffect } from 'react'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues._index'
import { getQueues, getQueueCount } from '~/lib/queries.server'
import { Sparkline } from '~/components/ui/sparkline'
import { Card, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { FilterSelect } from '~/components/ui/filter-select'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableHeader,
} from '~/components/ui/table'
import { formatTimeAgo, parsePageNumber, cn } from '~/lib/utils'
import type { QueueResult } from '~/lib/types'
import { dbContext } from '~/lib/db-context'

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const page = parsePageNumber(url.searchParams.get('page'))
  const filter = url.searchParams.get('filter') || 'all'
  const search = url.searchParams.get('search') || ''
  const limit = 50
  const offset = (page - 1) * limit

  // Validate filter
  const validFilter = ['all', 'attention', 'partitioned'].includes(filter)
    ? (filter as 'all' | 'attention' | 'partitioned')
    : 'all'

  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')

  const [queues, totalCount] = await Promise.all([
    getQueues(DB_URL, SCHEMA, {
      limit,
      offset,
      filter: validFilter,
      search,
      sort,
      dir,
    }),
    getQueueCount(DB_URL, SCHEMA, {
      filter: validFilter,
      search,
    }),
  ])

  const totalPages = Math.ceil(totalCount / limit)
  const hasNextPage = queues.length === limit
  const hasPrevPage = page > 1

  return {
    queues,
    totalCount,
    page,
    totalPages,
    hasNextPage,
    hasPrevPage,
    filter: validFilter,
    search,
  }
}

export function ErrorBoundary () {
  return (
    <div className="p-6">
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-red-600 dark:text-red-400 font-medium">Failed to load queues</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            Please check your database connection and try again.
          </p>
          <DbLink
            to="/"
            className="inline-block mt-4 text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
          >
            Back to Dashboard
          </DbLink>
        </CardContent>
      </Card>
    </div>
  )
}

export default function QueuesIndex ({ loaderData }: Route.ComponentProps) {
  const { queues, totalCount, page, totalPages, hasNextPage, hasPrevPage, filter, search } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()
  const [searchInput, setSearchInput] = useState(search)

  // Sync searchInput with URL search param when it changes
  useEffect(() => {
    setSearchInput(search)
  }, [search])

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams)
    params.set('page', newPage.toString())
    setSearchParams(params)
  }

  const handleSearch = (value: string) => {
    const params = new URLSearchParams(searchParams)
    if (value.trim()) {
      params.set('search', value.trim())
    } else {
      params.delete('search')
    }
    params.delete('page') // Reset to page 1 when searching
    setSearchParams(params)
  }

  const handleFilterChange = (newFilter: string) => {
    const params = new URLSearchParams(searchParams)
    if (newFilter === 'all') {
      params.delete('filter')
    } else {
      params.set('filter', newFilter)
    }
    params.delete('page') // Reset to page 1 when filtering
    setSearchParams(params)
  }

  const clearFilters = () => {
    setSearchParams({})
    setSearchInput('')
  }

  const hasActiveFilters = filter !== 'all' || search

  const filterLabels: Record<string, string> = {
    all: 'All Queues',
    attention: 'Needing Attention',
    partitioned: 'Partitioned',
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Queues"
        subtitle={`${totalCount.toLocaleString()} queue${totalCount !== 1 ? 's' : ''} ${hasActiveFilters ? 'found' : 'configured'}`}
        action={
          <DbLink to="/queues/create">
            <Button variant="primary" size="md">Create Queue</Button>
          </DbLink>
        }
      />

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <div className="relative">
            <input
              type="text"
              placeholder="Search queues by name..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSearch(searchInput)
                }
              }}
              className={cn(
                'w-full h-[38px] px-3 py-2 pl-10 rounded-lg border shadow-sm text-sm',
                'bg-[var(--surface-card)] border-[var(--border-strong)] text-[var(--text-primary)] placeholder-[var(--text-tertiary)]',
                'focus:outline-none focus:border-[var(--border-focus)] focus:shadow-[var(--shadow-focus)]'
              )}
            />
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-[18px] w-[18px] text-[var(--text-tertiary)]" />
            {searchInput && (
              <button
                onClick={() => {
                  setSearchInput('')
                  handleSearch('')
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer"
              >
                <XIcon className="h-[18px] w-[18px]" />
              </button>
            )}
          </div>
        </div>
        <FilterSelect
          value={filter}
          options={[
            { value: 'all', label: 'All Queues' },
            { value: 'attention', label: 'Needing Attention' },
            { value: 'partitioned', label: 'Partitioned' },
          ]}
          onChange={(value) => handleFilterChange(value)}
        />
      </div>

      {/* Active filters */}
      {hasActiveFilters && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-gray-500 dark:text-gray-400">Active filters:</span>
          {filter !== 'all' && (
            <Badge variant="primary" size="sm">
              {filterLabels[filter]}
              <button
                onClick={() => handleFilterChange('all')}
                className="ml-1 hover:text-primary-700 cursor-pointer"
              >
                ×
              </button>
            </Badge>
          )}
          {search && (
            <Badge variant="primary" size="sm">
              Search: {search}
              <button
                onClick={() => handleSearch('')}
                className="ml-1 hover:text-primary-700 cursor-pointer"
              >
                ×
              </button>
            </Badge>
          )}
          <button
            onClick={clearFilters}
            className="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 cursor-pointer"
          >
            Clear all
          </button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader column="name">Name</SortableHeader>
                <SortableHeader column="policy" className="w-28">Policy</SortableHeader>
                <SortableHeader column="queued" align="right" title="Queued">QU</SortableHeader>
                <SortableHeader column="deferred" align="right" title="Deferred">DF</SortableHeader>
                <SortableHeader column="ready" align="right" title="Ready">RE</SortableHeader>
                <TableHead className="w-32">Trend</TableHead>
                <SortableHeader column="active" align="right" title="Active">AC</SortableHeader>
                <SortableHeader column="failed" align="right" title="Failed">FA</SortableHeader>
                <SortableHeader column="total" align="right" title="Total">TO</SortableHeader>
                <SortableHeader column="storage" className="w-28">Storage</SortableHeader>
                <TableHead className="w-32">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={11}>
                    No queues found
                  </TableCell>
                </TableRow>
              ) : (
                queues.map((queue: QueueResult) => {
                  const hasBacklog =
                    (queue.warningQueueSize ?? 0) > 0 &&
                    queue.queuedCount > (queue.warningQueueSize ?? 0)

                  return (
                    <TableRow key={queue.name} to={`/queues/${encodeURIComponent(queue.name)}`}>
                      <TableCell>
                        <DbLink
                          to={`/queues/${encodeURIComponent(queue.name)}`}
                          className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                        >
                          {queue.name}
                        </DbLink>
                      </TableCell>
                      <TableCell>
                        <Badge variant="gray" size="sm">
                          {queue.policy}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                        {queue.queuedCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                        {queue.deferredCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                        {queue.readyCount.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {queue.readyHistory && queue.readyHistory.length > 0 ? (
                          <Sparkline
                            // Stored newest-first; reverse to chronological (oldest → newest).
                            data={[...queue.readyHistory].reverse()}
                            width={96}
                            height={20}
                            color="var(--primary-600)"
                            showDot={false}
                            aria-label={`Ready count trend for ${queue.name}`}
                          />
                        ) : (
                          <span className="text-[var(--border-strong)]">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                        {queue.activeCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                        {queue.failedCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                        {queue.totalCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-[var(--text-secondary)]">
                        {queue.partition ? 'Partitioned' : 'Shared'}
                      </TableCell>
                      <TableCell>
                        {hasBacklog ? (
                          <Badge variant="error" size="sm" dot>
                            Backlogged
                          </Badge>
                        ) : queue.activeCount > 0 ? (
                          <Badge variant="success" size="sm" dot>
                            Processing
                          </Badge>
                        ) : (
                          <Badge variant="gray" size="sm" dot>
                            Idle
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--border-subtle)]">
            <div className="text-sm text-[var(--text-tertiary)]">
              Page <b className="pgb-num text-[var(--text-secondary)] font-medium">{page}</b> of <b className="pgb-num text-[var(--text-secondary)] font-medium">{totalPages}</b>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page - 1)}
                disabled={!hasPrevPage}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page + 1)}
                disabled={!hasNextPage}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function SearchIcon ({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
      />
    </svg>
  )
}

function XIcon ({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 18 18 6M6 6l12 12"
      />
    </svg>
  )
}
