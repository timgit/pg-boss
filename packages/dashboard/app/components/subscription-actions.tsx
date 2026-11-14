import { useFetcher } from 'react-router'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { DbLink } from '~/components/db-link'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import { useReadOnly } from '~/components/send-job-button'

/** Opens the new subscription form, on `event` when it's given. Nothing in read-only mode. */
export function NewSubscriptionButton ({ event }: { event?: string }) {
  if (useReadOnly()) return null

  return (
    <Button variant={event ? 'outline' : 'primary'} size="md" render={<DbLink to={event ? `/subscribe?${new URLSearchParams({ event })}` : '/subscribe'} />}>
      {event ? 'Subscribe queue' : 'New subscription'}
    </Button>
  )
}

/** The Subscriptions page's header actions: the overlay's, when one fills `pageActions`, or New subscription. */
export function SubscriptionsPageActions () {
  return hasProSlot('pageActions') ? <ProSlot name="pageActions" page="subscriptions" /> : <NewSubscriptionButton />
}

/** Opens the publish form on `event`. Nothing in read-only mode. */
export function PublishButton ({ event }: { event: string }) {
  if (useReadOnly()) return null

  return (
    <Button variant="primary" size="md" render={<DbLink to={`/publish?${new URLSearchParams({ event })}`} />}>
      Publish
    </Button>
  )
}

/** An event page's header actions: the overlay's, when one fills `subscriptionActions`, or Subscribe queue and Publish. */
export function SubscriptionActions ({ event }: { event: string }) {
  const readOnly = useReadOnly()

  if (hasProSlot('subscriptionActions')) return <ProSlot name="subscriptionActions" subscription={{ event }} />
  if (readOnly) return null

  return (
    <span className="flex items-center gap-3">
      <NewSubscriptionButton event={event} />
      <PublishButton event={event} />
    </span>
  )
}

/** One queue's Unsubscribe, after a confirmation. Posts to the event page's own action. */
export function UnsubscribeButton ({ event, queue }: { event: string, queue: string }) {
  const fetcher = useFetcher<{ error?: string }>()
  const busy = fetcher.state !== 'idle'

  if (useReadOnly()) return null

  return (
    <span className="inline-flex items-center gap-3">
      {fetcher.data?.error && (
        <span role="status" className="max-w-xs whitespace-normal text-xs text-[var(--state-failed-fg)]">{fetcher.data.error}</span>
      )}
      <ConfirmDialog
        title="Unsubscribe"
        description={`Unsubscribe ${queue} from ${event}? Publishing ${event} sends no more jobs to ${queue}. Jobs already in ${queue} stay there.`}
        confirmLabel="Unsubscribe"
        confirmVariant="danger"
        triggerVariant="outline"
        trigger={<span className="text-[var(--state-failed-fg)]">Unsubscribe</span>}
        onConfirm={() => fetcher.submit({ intent: 'unsubscribe', queue }, { method: 'post' })}
        disabled={busy}
      />
    </span>
  )
}

/** Whether an event page's queue rows have an actions column: the overlay's, or the dashboard's when it can change things. */
export function useSubscriptionRowActions (): boolean {
  const readOnly = useReadOnly()
  return hasProSlot('subscriptionRowActions') || !readOnly
}

/** A queue row's actions on an event page: the overlay's, when one fills `subscriptionRowActions`, or Unsubscribe. */
export function SubscriptionRowActions ({ event, queue }: { event: string, queue: string }) {
  return hasProSlot('subscriptionRowActions')
    ? <ProSlot name="subscriptionRowActions" subscription={{ event, queue }} />
    : <UnsubscribeButton event={event} queue={queue} />
}
