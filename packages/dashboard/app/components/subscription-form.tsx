import { useState } from 'react'
import { Form } from 'react-router'
import { DbLink } from '~/components/db-link'
import { Field, inputClass } from '~/components/form-field'
import { LeaveGuard } from '~/components/leave-guard'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { QueueSelect } from '~/components/ui/queue-select'
import { cn } from '~/lib/utils'

interface SubscriptionFormProps {
  /** The action's refusal, shown above the fields. */
  error?: string
  saving: boolean
  /** The fields' starting values, such as the event of the page the form was opened from. */
  event?: string
  queue?: string
  /** Where Cancel goes. */
  cancelTo: string
}

/**
 * The fields of the new subscription form, posting `event` and `queueName` to the route that draws
 * it. Shared, so a Pro build draws the same form over an action of its own.
 */
export function SubscriptionForm ({ error, saving, event = '', queue: initialQueue = '', cancelTo }: SubscriptionFormProps) {
  const [dirty, setDirty] = useState(false)
  const [queue, setQueue] = useState(initialQueue)

  return (
    <>
      <LeaveGuard dirty={dirty && !saving} unsaved="The queue hasn't been subscribed." />

      <Card>
        <CardHeader>
          <CardTitle>Subscription details</CardTitle>
        </CardHeader>
        <CardContent>
          <Form
            method="post"
            className="space-y-5"
            onChange={() => setDirty(true)}
            onSubmit={() => setDirty(false)}
          >
            {error && (
              <div role="alert" className="rounded-lg border border-[var(--state-failed-border)] bg-[var(--state-failed-bg)] px-4 py-3 text-sm text-[var(--state-failed-fg)]">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="event" label="Event" hint="The name boss.publish() is called with, such as user.signed-up.">
                <input type="text" id="event" name="event" required defaultValue={event} className={cn(inputClass, 'font-mono')} />
              </Field>
              <Field id="queueName" label="Queue" hint="Each event published gets one job in this queue.">
                <QueueSelect
                  id="queueName"
                  name="queueName"
                  value={queue}
                  onChange={(next) => {
                    setQueue(next)
                    setDirty(true)
                  }}
                />
              </Field>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={saving || !queue}>
                {saving ? 'Subscribing…' : 'Subscribe'}
              </Button>
              <DbLink to={cancelTo} className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                Cancel
              </DbLink>
            </div>
          </Form>
        </CardContent>
      </Card>
    </>
  )
}
