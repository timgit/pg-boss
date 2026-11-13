import { useFetcher } from 'react-router'
import { Trash2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { DbLink } from '~/components/db-link'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import { useReadOnly } from '~/components/send-job-button'

/** Opens the new schedule form. Nothing in read-only mode. */
export function NewScheduleButton () {
  if (useReadOnly()) return null

  return (
    <Button variant="primary" size="md" render={<DbLink to="/schedules/new" />}>
      New schedule
    </Button>
  )
}

/** The Schedules page's header actions: the overlay's, when one fills `pageActions`, or New schedule. */
export function SchedulesPageActions () {
  return hasProSlot('pageActions') ? <ProSlot name="pageActions" page="schedules" /> : <NewScheduleButton />
}

/** A schedule's Unschedule, after a confirmation. Posts to the schedule page's own action. */
export function UnscheduleButton ({ name, scheduleKey }: { name: string, scheduleKey: string | null }) {
  const fetcher = useFetcher<{ error: string }>()
  const busy = fetcher.state !== 'idle'

  if (useReadOnly()) return null

  const label = scheduleKey ? `${name} (${scheduleKey})` : name

  return (
    <>
      {fetcher.data?.error && (
        <span role="status" className="max-w-xs text-xs text-[var(--state-failed-fg)]">{fetcher.data.error}</span>
      )}
      <ConfirmDialog
        title="Unschedule"
        description={`Remove the schedule ${label}? It sends no more jobs. Jobs it already sent stay in the queue.`}
        confirmLabel="Unschedule"
        confirmVariant="danger"
        triggerVariant="outline"
        trigger={<span className="inline-flex items-center gap-2 text-[var(--state-failed-fg)]"><Trash2 className="h-4 w-4" aria-hidden="true" />Unschedule</span>}
        onConfirm={() => fetcher.submit({ intent: 'unschedule' }, { method: 'post' })}
        disabled={busy}
      />
    </>
  )
}

/** A schedule page's actions: the overlay's, when one fills `scheduleActions`, or Unschedule. */
export function ScheduleActions ({ name, scheduleKey }: { name: string, scheduleKey: string | null }) {
  return hasProSlot('scheduleActions')
    ? <ProSlot name="scheduleActions" schedule={{ name, key: scheduleKey }} />
    : <UnscheduleButton name={name} scheduleKey={scheduleKey} />
}
