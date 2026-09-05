import { useSearchParams } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/schedules'
import { useReadOnly } from '~/lib/read-only'
import {
  getSchedules,
  getScheduleCount,
} from '~/lib/queries.server'
import { nextCronOccurrence } from '~/lib/cron.server'
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
  SortableHeader,
} from '~/components/ui/table'
import { Pagination } from '~/components/ui/pagination'
import { ErrorCard } from '~/components/error-card'
import { dbContext } from '~/lib/db-context'
import {
  parsePageNumber,
  formatDate,
  formatTimeUntil,
} from '~/lib/utils'

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const page = parsePageNumber(url.searchParams.get('page'))
  const limit = 20
  const offset = (page - 1) * limit
  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')

  const [schedules, totalCount] = await Promise.all([
    getSchedules(DB_URL, SCHEMA, { limit, offset, sort, dir }),
    getScheduleCount(DB_URL, SCHEMA),
  ])

  // Derive each schedule's next fire time from its cron + timezone (null if the cron is unparseable).
  const schedulesWithNext = schedules.map((schedule) => {
    const next = nextCronOccurrence(schedule.cron, schedule.timezone)
    return { ...schedule, nextOccurrence: next ? next.toISOString() : null }
  })

  const totalPages = Math.ceil(totalCount / limit)
  const hasNextPage = schedules.length === limit
  const hasPrevPage = page > 1

  return {
    schedules: schedulesWithNext,
    totalCount,
    page,
    totalPages,
    hasNextPage,
    hasPrevPage,
  }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Failed to load schedules" error={error} />
}

function ordinal (n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Readable description for the common cron patterns; falls back to
// 'Custom schedule' for anything bespoke. A pattern is only described when
// every field it ignores is a wildcard — '0 4 * * 0' is weekly on Sunday,
// never 'Every day at 04:00'.
export function cronHuman (cron: string): string {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return 'Custom schedule'
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string]
  const anyDom = dom === '*'
  const anyMon = mon === '*'
  const anyDow = dow === '*'

  if (/^\*\/\d+$/.test(m) && h === '*' && anyDom && anyMon && anyDow) {
    const step = Number(m.slice(2))
    return step === 1 ? 'Every minute' : `Every ${step} minutes`
  }
  if (h === '*' && anyDom && anyMon && anyDow && /^\d+$/.test(m)) {
    return m === '0' ? 'Every hour on the hour' : `Every hour at :${m.padStart(2, '0')}`
  }

  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return 'Custom schedule'
  const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  if (anyDom && anyMon && anyDow) {
    return time === '00:00' ? 'Every day at midnight' : `Every day at ${time}`
  }
  if (anyDom && anyMon && /^[0-7]$/.test(dow)) {
    return `Weekly on ${WEEKDAYS[Number(dow) % 7]} at ${time}`
  }
  if (anyMon && anyDow && /^\d+$/.test(dom)) {
    return `Monthly on the ${ordinal(Number(dom))} at ${time}`
  }
  return 'Custom schedule'
}

export default function Schedules ({ loaderData }: Route.ComponentProps) {
  const readOnly = useReadOnly()
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
        action={readOnly ? undefined : (
          <DbLink to="/schedules/new">
            <Button variant="primary" size="md" className='cursor-pointer'>Schedule Job</Button>
          </DbLink>
        )}
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
                <SortableHeader column="name">Queue</SortableHeader>
                <SortableHeader column="key">Key</SortableHeader>
                <SortableHeader column="cron">Cron</SortableHeader>
                <TableHead>Frequency</TableHead>
                <TableHead>Next occurrence</TableHead>
                <SortableHeader column="timezone">Timezone</SortableHeader>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={6}>
                    No schedules found
                  </TableCell>
                </TableRow>
              ) : (
                schedules.map((schedule) => {
                  const scheduleKey = schedule.key || '__default__'
                  const schedulePath = `/schedules/${encodeURIComponent(schedule.name)}/${encodeURIComponent(scheduleKey)}`

                  return (
                    <TableRow
                      key={`${schedule.name}:${schedule.key}`}
                      to={schedulePath}
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
                      <TableCell className="text-[var(--text-secondary)]">
                        {schedule.nextOccurrence ? (
                          <span title={formatDate(new Date(schedule.nextOccurrence))}>
                            {formatTimeUntil(new Date(schedule.nextOccurrence))}
                          </span>
                        ) : (
                          <span className="text-[var(--border-strong)]">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {schedule.timezone
                          ? <Badge variant="gray" size="sm">{schedule.timezone}</Badge>
                          : <span className="text-[var(--border-strong)]">—</span>}
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
