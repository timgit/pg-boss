import { useSearchParams } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/schedules'
import {
  getSchedules,
  getScheduleCount,
} from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
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
import { dbContext } from '~/lib/db-context'
import {
  parsePageNumber,
  formatDate,
} from '~/lib/utils'

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const page = parsePageNumber(url.searchParams.get('page'))
  const limit = 20
  const offset = (page - 1) * limit

  const [schedules, totalCount] = await Promise.all([
    getSchedules(DB_URL, SCHEMA, { limit, offset }),
    getScheduleCount(DB_URL, SCHEMA),
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

// Readable description for the common cron patterns; falls back to the raw
// fields for anything bespoke. Purely derived from the cron string.
function cronHuman (cron: string): string {
  const known: Record<string, string> = {
    '0 2 * * *': 'Every day at 02:00',
    '*/15 * * * *': 'Every 15 minutes',
    '0 0 1 * *': 'Monthly on the 1st at 00:00',
    '0 * * * *': 'Every hour on the hour',
    '0 0 * * *': 'Every day at midnight',
  }
  if (known[cron]) return known[cron]
  const [m, h] = cron.split(' ')
  if (m === '0' && h && h !== '*') return `Every day at ${h.padStart(2, '0')}:00`
  if (m?.startsWith('*/')) return `Every ${m.slice(2)} minutes`
  return 'Custom schedule'
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
    <div className="space-y-4">
      <PageHeader
        title="Schedules"
        subtitle="Cron-based jobs queued automatically by pg-boss"
        action={
          <DbLink to="/schedules/new">
            <Button variant="primary" size="md" className='cursor-pointer'>Schedule Job</Button>
          </DbLink>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>All schedules</CardTitle>
          {totalCount !== null && (
            <span className="pgb-num text-xs text-[var(--text-tertiary)]">
              {totalCount.toLocaleString()} total
            </span>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Cron</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={7}>
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
                          className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                        >
                          {schedule.name}
                        </DbLink>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                        {schedule.key}
                      </TableCell>
                      <TableCell className="pgb-num text-[var(--text-primary)]">
                        {schedule.cron}
                      </TableCell>
                      <TableCell className="text-[var(--text-secondary)]">
                        {cronHuman(schedule.cron)}
                      </TableCell>
                      <TableCell>
                        {schedule.timezone
                          ? <Badge variant="gray" size="sm">{schedule.timezone}</Badge>
                          : <span className="text-[var(--border-strong)]">—</span>}
                      </TableCell>
                      <TableCell className="pgb-num text-[var(--text-tertiary)]">
                        {formatDate(new Date(schedule.createdOn))}
                      </TableCell>
                      <TableCell className="pgb-num text-[var(--text-tertiary)]">
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
