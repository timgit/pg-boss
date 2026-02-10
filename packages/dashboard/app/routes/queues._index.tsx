import { useSearchParams } from 'react-router'
import { useState, useEffect } from 'react'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues._index'
import { getQueues, getQueueCount } from '~/lib/queries.server'
import { Card, CardContent } from '~/components/ui/card'
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
} from '~/components/ui/table'
import { formatTimeAgo, parsePageNumber, cn } from '~/lib/utils'
import type { QueueResult } from '~/lib/types'

export async function loader ({ request, context }: Route.LoaderArgs) {
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

  const [queues, totalCount] = await Promise.all([
    getQueues(context.DB_URL, context.SCHEMA, {
      limit,
      offset,
      filter: validFilter,
      search,
    }),
    getQueueCount(context.DB_URL, context.SCHEMA, {
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
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Queues</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {totalCount.toLocaleString()} queue{totalCount !== 1 ? 's' : ''} {hasActiveFilters ? 'found' : 'configured'}
          </p>
        </div>
        <DbLink to="/queues/create">
          <Button variant="primary" size="md">Create Queue</Button>
        </DbLink>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
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
                'w-full px-4 py-2 pl-10 rounded-lg border shadow-sm',
                'bg-white border-gray-300 text-gray-900 placeholder-gray-500',
                'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-400',
                'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-primary-600',
                'dark:focus:ring-primary-500 dark:focus:border-primary-500'
              )}
            />
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
            {searchInput && (
              <button
                onClick={() => {
                  setSearchInput('')
                  handleSearch('')
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
              >
                <XIcon className="h-5 w-5" />
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
                <TableHead>Name</TableHead>
                <TableHead>Policy</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead className="text-right">Queued</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Deferred</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Dead Letter</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-gray-500 dark:text-gray-400 py-8" colSpan={9}>
                    No queues found
                  </TableCell>
                </TableRow>
              ) : (
                queues.map((queue: QueueResult) => {
                  const hasBacklog =
                    (queue.warningQueueSize ?? 0) > 0 &&
                    queue.queuedCount > (queue.warningQueueSize ?? 0)

                  return (
                    <TableRow key={queue.name}>
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
                      <TableCell className="text-gray-700 dark:text-gray-300">
                        {queue.partition ? 'Partitioned' : 'Shared'}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.queuedCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.activeCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.deferredCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.totalCount.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {queue.deadLetter ? (
                          <DbLink
                            to={`/queues/${encodeURIComponent(queue.deadLetter)}`}
                            className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                          >
                            {queue.deadLetter}
                          </DbLink>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">—</span>
                        )}
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
          <div className={cn(
            'flex items-center justify-between px-6 py-4 border-t',
            'border-gray-200 dark:border-gray-800'
          )}>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Page {page} of {totalPages}
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
