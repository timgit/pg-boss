import { useSearchParams } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/schedules'
import {
  getSchedules,
  getScheduleCount,
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
import { ErrorCard } from '~/components/error-card'
import type { ScheduleResult } from '~/lib/types'
import {
  parsePageNumber,
  formatDate,
} from '~/lib/utils'

export async function loader ({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const page = parsePageNumber(url.searchParams.get('page'))
  const limit = 20
  const offset = (page - 1) * limit

  const [schedules, totalCount] = await Promise.all([
    getSchedules(context.DB_URL, context.SCHEMA, { limit, offset }),
    getScheduleCount(context.DB_URL, context.SCHEMA),
  ])

  const totalPages = Math.ceil(totalCount / limit)
  const hasNextPage = schedules.length === limit
  const hasPrevPage = page > 1

  return {
    schedules,
    totalCount,
    page,
    totalPages,
    hasNextPage,
    hasPrevPage,
  }
}

export function ErrorBoundary () {
  return <ErrorCard title="Failed to load schedules" />
}

export default function Schedules ({ loaderData }: Route.ComponentProps) {
  const { schedules, totalCount, page, totalPages, hasNextPage, hasPrevPage } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams)
    params.set('page', newPage.toString())
    setSearchParams(params)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Schedules</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Cron-based job schedules
          </p>
        </div>
        <DbLink to="/schedules/new">
          <Button variant="primary" size="md" className='cursor-pointer'>Schedule Job</Button>
        </DbLink>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Schedules
            {totalCount !== null && ` (${totalCount.toLocaleString()})`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Cron</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-gray-500 dark:text-gray-400 py-8" colSpan={6}>
                    No schedules found
                  </TableCell>
                </TableRow>
              ) : (
                schedules.map((schedule: ScheduleResult) => {
                  const scheduleKey = schedule.key || '__default__'
                  const schedulePath = `/schedules/${encodeURIComponent(schedule.name)}/${encodeURIComponent(scheduleKey)}`

                  return (
                    <TableRow
                      key={`${schedule.name}:${schedule.key}`}
                    >
                      <TableCell>
                        <DbLink
                          to={schedulePath}
                          className="font-medium text-gray-900 dark:text-gray-100"
                        >
                          {schedule.name}
                        </DbLink>
                      </TableCell>
                      <TableCell>
                        {schedule.key}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-gray-700 dark:text-gray-300">
                          {schedule.cron}
                        </code>
                      </TableCell>
                      <TableCell>
                        {schedule.timezone || <span className="text-gray-400 dark:text-gray-500">—</span>}
                      </TableCell>
                      <TableCell>
                        {formatDate(new Date(schedule.createdOn))}
                      </TableCell>
                      <TableCell>
                        {formatDate(new Date(schedule.updatedOn))}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>

        {totalCount > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            hasNextPage={hasNextPage}
            hasPrevPage={hasPrevPage}
            onPageChange={handlePageChange}
          />
        )}
      </Card>
    </div>
  )
}
