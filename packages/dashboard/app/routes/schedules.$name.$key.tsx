import { redirect } from 'react-router'
import { DbLink, resolveDbHref } from '~/components/db-link'
import { ParentLink } from '~/components/parent-link'
import type { Route } from './+types/schedules.$name.$key'
import { ScheduleActions } from '~/components/schedule-actions'
import { getSchedule } from '~/lib/queries.server'
import { nextScheduleOccurrence } from '~/lib/schedule.server'
import { dbContext } from '~/lib/db-context'
import { removeSchedule } from '~/lib/schedule-job.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { ErrorCard } from '~/components/error-card'
import { formatDate, formatTimeUntil } from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => (params.name ? `Schedule: ${params.name}${params.key && params.key !== '__default__' ? ` (${params.key})` : ''}` : null) }

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  // Decode __default__ placeholder back to empty string
  const key = params.key === '__default__' ? '' : params.key
  const schedule = await getSchedule(DB_URL, SCHEMA, params.name, key)

  if (!schedule) {
    throw new Response('Schedule not found', { status: 404 })
  }

  const next = nextScheduleOccurrence(schedule.cron, schedule.timezone)
  return { schedule, nextOccurrence: next ? next.toISOString() : null }
}

// Read-only mode refuses the post before it gets here. In a Pro build, Pro's Unschedule posts to a
// route of its own, which checks the role and records the change.
export async function action ({ params, request, context }: Route.ActionArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const form = await request.formData()

  if (form.get('intent') !== 'unschedule') return { error: 'Unknown action' }

  const removed = await removeSchedule(DB_URL, SCHEMA, params.name, params.key === '__default__' ? '' : params.key)
  if ('error' in removed) return { error: removed.error }

  return redirect(resolveDbHref('/schedules', new URL(request.url).searchParams.get('schema')))
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return (
    <ErrorCard
      title="Error loading schedule"
      error={error}
      backTo={{ href: '/schedules', label: 'Back to Schedules' }}
    />
  )
}

export default function ScheduleDetail ({ loaderData }: Route.ComponentProps) {
  const { schedule, nextOccurrence } = loaderData

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <ParentLink to="/schedules" label="Schedules" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Schedule: {schedule.name}
            {schedule.key && (
              <span className="font-normal text-gray-500 dark:text-gray-400"> ({schedule.key})</span>
            )}
          </h1>
        </div>
        <div className="flex flex-col items-end gap-3">
          <div className="flex items-center gap-3">
            <ScheduleActions name={schedule.name} scheduleKey={schedule.key || null} />
          </div>
          <div className="flex gap-6 text-sm text-[var(--text-tertiary)]">
            <span>Created {formatDate(new Date(schedule.createdOn))}</span>
            {new Date(schedule.updatedOn).getTime() !== new Date(schedule.createdOn).getTime() && (
              <span>Updated {formatDate(new Date(schedule.updatedOn))}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Scheduled Job</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-start gap-x-12 gap-y-4">
              <div>
                <dt className="pgb-eyebrow">Queue</dt>
                <dd className="mt-1 text-sm">
                  <DbLink
                    to={`/queues/${encodeURIComponent(schedule.name)}`}
                    className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                  >
                    {schedule.name}
                  </DbLink>
                </dd>
              </div>
              <div>
                <dt className="pgb-eyebrow">Key</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {schedule.key || <span className="text-gray-400 dark:text-gray-500">—</span>}
                </dd>
              </div>
              <div>
                <dt className="pgb-eyebrow">Last job</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {schedule.lastJobId ? (
                    <DbLink
                      to={`/queues/${encodeURIComponent(schedule.name)}/jobs/${encodeURIComponent(schedule.lastJobId)}`}
                      className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                    >
                      {schedule.lastJobId}
                    </DbLink>
                  ) : (
                    // Null both before the schedule has ever fired and on a database older than
                    // schema v41, where the column the pass writes does not exist yet.
                    <span className="text-gray-400 dark:text-gray-500">—</span>
                  )}
                </dd>
              </div>
            </div>

            <div className="flex flex-wrap items-start gap-x-12 gap-y-4">
              <div>
                <dt className="pgb-eyebrow">{schedule.kind === 'rrule' ? 'Recurrence Rule' : 'Cron Expression'}</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
                    {schedule.cron}
                  </code>
                  <Badge variant="gray" size="sm">{schedule.timezone || 'UTC'}</Badge>
                </dd>
              </div>
              <div>
                <dt className="pgb-eyebrow">Next occurrence</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {nextOccurrence ? (
                    <>
                      {formatDate(new Date(nextOccurrence))}
                      <span className="text-gray-500 dark:text-gray-400"> ({formatTimeUntil(new Date(nextOccurrence))})</span>
                    </>
                  ) : (
                    <span className="text-gray-400 dark:text-gray-500">—</span>
                  )}
                </dd>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Data on the left and options on the right, stacked on narrow screens; either alone fills the row. */}
        <div className="grid items-start gap-6 lg:grid-cols-2">
          {schedule.data && (
            <Card className={schedule.options ? undefined : 'lg:col-span-2'}>
              <CardHeader>
                <CardTitle>Data</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-4 rounded overflow-auto text-gray-700 dark:text-gray-300">
                  {JSON.stringify(schedule.data, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}

          {schedule.options && (
            <Card className={schedule.data ? undefined : 'lg:col-span-2'}>
              <CardHeader>
                <CardTitle>Options</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-4 rounded overflow-auto text-gray-700 dark:text-gray-300">
                  {JSON.stringify(schedule.options, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

    </div>
  )
}
