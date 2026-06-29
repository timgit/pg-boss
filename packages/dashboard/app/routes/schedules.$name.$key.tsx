import { useState } from 'react'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/schedules.$name.$key'
import { getSchedule } from '~/lib/queries.server'
import { nextCronOccurrence } from '~/lib/cron.server'
import { unschedule } from '~/lib/boss.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { ErrorCard } from '~/components/error-card'
import { formatDate, formatTimeUntil } from '~/lib/utils'
import { redirect } from 'react-router'

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  // Decode __default__ placeholder back to empty string
  const key = params.key === '__default__' ? '' : params.key
  const schedule = await getSchedule(DB_URL, SCHEMA, params.name, key)

  if (!schedule) {
    throw new Response('Schedule not found', { status: 404 })
  }

  const next = nextCronOccurrence(schedule.cron, schedule.timezone)
  return { schedule, nextOccurrence: next ? next.toISOString() : null }
}

export async function action ({ params, request, context }: Route.ActionArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const formData = await request.formData()
  const intent = formData.get('intent')

  if (intent === 'unschedule') {
    try {
      // Decode __default__ placeholder back to empty string
      const key = params.key === '__default__' ? undefined : params.key
      await unschedule(DB_URL, SCHEMA, params.name, key)
      return redirect('/schedules')
    } catch (err) {
      return { error: `Failed to unschedule: ${err}` }
    }
  }

  return { error: 'Invalid action' }
}

export function ErrorBoundary () {
  return (
    <ErrorCard
      title="Failed to load schedule"
      backTo={{ href: '/schedules', label: 'Back to Schedules' }}
    />
  )
}

export default function ScheduleDetail ({ loaderData, actionData }: Route.ComponentProps) {
  const { schedule, nextOccurrence } = loaderData
  const [confirmDialog, setConfirmDialog] = useState(false)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {schedule.name}
            {schedule.key && (
              <span className="font-normal text-gray-500 dark:text-gray-400"> ({schedule.key})</span>
            )}
          </h1>
        </div>
        <div className="flex flex-col items-end gap-3">
          <Button
            variant="danger"
            size="md"
            className="cursor-pointer"
            onClick={() => setConfirmDialog(true)}
          >
            Unschedule
          </Button>
          <div className="flex gap-6 text-sm text-[var(--text-tertiary)]">
            <span>Created {formatDate(new Date(schedule.createdOn))}</span>
            {new Date(schedule.updatedOn).getTime() !== new Date(schedule.createdOn).getTime() && (
              <span>Updated {formatDate(new Date(schedule.updatedOn))}</span>
            )}
          </div>
        </div>
      </div>

      {actionData?.error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-4">
          <p className="text-sm text-red-800 dark:text-red-200">{actionData.error}</p>
        </div>
      )}

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Scheduled Job</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-12">
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
            </div>

            <div>
              <dt className="pgb-eyebrow">Cron Expression</dt>
              <dd className="mt-1 flex items-center gap-2">
                <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-gray-700 dark:text-gray-300">
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

          </CardContent>
        </Card>

        {schedule.data && (
          <Card>
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
          <Card>
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

      {/* Confirmation Dialog */}
      <Dialog open={confirmDialog} onOpenChange={setConfirmDialog}>
        <DialogContent hideCloseButton className="w-[28rem] max-w-[calc(100vw-2rem)]">
          <form method="post">
            <input type="hidden" name="intent" value="unschedule" />
            <DialogHeader>
              <DialogTitle>Unschedule Job</DialogTitle>
<DialogDescription className="mt-2">
                 Are you sure you want to unschedule? This will stop the recurring job from being created.
               </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-6 flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => setConfirmDialog(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                size="sm"
                className="cursor-pointer"
              >
                Unschedule
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
