import { useSearchParams } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/jobs'
import {
  getRecentJobs,
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

  const recentJobs = await getRecentJobs(context.DB_URL, context.SCHEMA, {
    state: stateFilter,
    limit,
    offset,
  })

  const hasNextPage = recentJobs.length === limit
  const hasPrevPage = page > 1

  return {
    recentJobs,
    page,
    stateFilter,
    hasNextPage,
    hasPrevPage,
  }
}

export function ErrorBoundary () {
  return <ErrorCard title="Failed to load jobs" />
}

export default function Jobs ({ loaderData }: Route.ComponentProps) {
  const { recentJobs, page, stateFilter, hasNextPage, hasPrevPage } = loaderData
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
