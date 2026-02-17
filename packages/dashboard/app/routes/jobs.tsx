import { useState } from 'react'
import { useSearchParams, redirect, useFetcher } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/jobs'
import {
  getRecentJobs,
  getQueues,
  searchJobById,
} from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '~/components/ui/table'
import { Pagination } from '~/components/ui/pagination'
import { FilterSelect } from '~/components/ui/filter-select'
import { ErrorCard } from '~/components/error-card'
import type { JobResult } from '~/lib/types'
import {
  parsePageNumber,
  formatDate,
  JOB_STATE_VARIANTS,
  JOB_STATE_OPTIONS,
  isValidJobState,
  DEFAULT_STATE_FILTER,
  cn,
} from '~/lib/utils'

export async function loader ({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const stateParam = url.searchParams.get('state')

  // Default to 'pending' filter to avoid showing completed/failed jobs
  // Users can explicitly select 'all' to see all jobs
  const stateFilter = stateParam !== null && isValidJobState(stateParam)
    ? stateParam
    : DEFAULT_STATE_FILTER

  const page = parsePageNumber(url.searchParams.get('page'))
  const limit = 20
  const offset = (page - 1) * limit

  const [recentJobs, queues] = await Promise.all([
    getRecentJobs(context.DB_URL, context.SCHEMA, {
      state: stateFilter,
      limit,
      offset,
    }),
    getQueues(context.DB_URL, context.SCHEMA),
  ])

  const hasNextPage = recentJobs.length === limit
  const hasPrevPage = page > 1

  return {
    recentJobs,
    queues,
    page,
    stateFilter,
    hasNextPage,
    hasPrevPage,
  }
}

export async function action ({ request, context }: Route.ActionArgs) {
  const formData = await request.formData()
  const jobId = (formData.get('jobId') as string | null)?.trim()
  const queueName = (formData.get('queueName') as string | null)?.trim() || null

  if (!jobId) {
    return { searchError: 'Job ID is required' }
  }

  const result = await searchJobById(context.DB_URL, context.SCHEMA, jobId, queueName)

  if (!result) {
    return { searchError: 'Job not found' }
  }

  const url = new URL(request.url)
  const dbParam = url.searchParams.get('db')
  const redirectUrl = dbParam
    ? `/queues/${encodeURIComponent(result.name)}/jobs/${encodeURIComponent(jobId)}?db=${encodeURIComponent(dbParam)}`
    : `/queues/${encodeURIComponent(result.name)}/jobs/${encodeURIComponent(jobId)}`

  return redirect(redirectUrl)
}

export function ErrorBoundary () {
  return <ErrorCard title="Failed to load jobs" />
}

export default function Jobs ({ loaderData }: Route.ComponentProps) {
  const { recentJobs, queues, page, stateFilter, hasNextPage, hasPrevPage } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()
  const fetcher = useFetcher<{ searchError?: string }>()
  const isSearching = fetcher.state !== 'idle'

  const [selectedQueue, setSelectedQueue] = useState('')

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
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Jobs</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Recently created jobs across all queues
          </p>
        </div>
        <DbLink to="/send">
          <Button variant="primary" size="md">Send Job</Button>
        </DbLink>
      </div>

      {/* Search by Job ID */}
      <Card>
        <CardHeader>
          <CardTitle>Search by Job ID</CardTitle>
        </CardHeader>
        <CardContent>
          <fetcher.Form method="post" className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <input
                  type="text"
                  name="jobId"
                  placeholder="Enter job ID (UUID)"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm font-mono',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
              </div>
              <div className="sm:w-56">
                <select
                  name="queueName"
                  value={selectedQueue}
                  onChange={(e) => setSelectedQueue(e.target.value)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                >
                  <option value="">All queues (global)</option>
                  {queues.map((q: any) => (
                    <option key={q.name} value={q.name}>{q.name}</option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="primary" size="md" disabled={isSearching}>
                {isSearching ? 'Searching...' : 'Search'}
              </Button>
            </div>

            {!selectedQueue && (
              <p className={cn(
                'text-xs px-3 py-2 rounded-lg',
                'bg-amber-50 border border-amber-200 text-amber-700',
                'dark:bg-amber-950 dark:border-amber-800 dark:text-amber-400'
              )}>
                Searching across all queues can be very slow on large projects. Selecting a specific queue is strongly recommended.
              </p>
            )}

            {fetcher.data?.searchError && (
              <p className={cn(
                'text-xs px-3 py-2 rounded-lg',
                'bg-red-50 border border-red-200 text-red-700',
                'dark:bg-red-950 dark:border-red-800 dark:text-red-400'
              )}>
                {fetcher.data.searchError}
              </p>
            )}
          </fetcher.Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Jobs</CardTitle>
          <FilterSelect
            value={stateFilter}
            options={JOB_STATE_OPTIONS}
            onChange={(value) => handleFilterChange('state', value)}
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Queue</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Retries</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-gray-500 dark:text-gray-400 py-8" colSpan={5}>
                    No jobs found
                  </TableCell>
                </TableRow>
              ) : (
                recentJobs.map((job: JobResult) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <DbLink
                        to={`/queues/${encodeURIComponent(job.name)}/jobs/${job.id}`}
                        className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                      >
                        {job.id.slice(0, 8)}...
                      </DbLink>
                    </TableCell>
                    <TableCell className="text-gray-700 dark:text-gray-300">
                      {job.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant={JOB_STATE_VARIANTS[job.state]} size="sm">
                        {job.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-gray-700 dark:text-gray-300">
                      {job.retryCount} / {job.retryLimit}
                    </TableCell>
                    <TableCell className="text-gray-500 dark:text-gray-400">
                      {formatDate(new Date(job.createdOn))}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <Pagination
          page={page}
          totalPages={null}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
          onPageChange={handlePageChange}
        />
      </Card>
    </div>
  )
}
