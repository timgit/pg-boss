import { useState } from 'react'
import { Form } from 'react-router'
import { SchemaLink } from '~/components/schema-link'
import { Field, inputClass } from '~/components/form-field'
import { JobFields } from '~/components/job-fields'
import { LeaveGuard } from '~/components/leave-guard'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { cn } from '~/lib/utils'

interface PublishFormProps {
  /** The action's refusal, shown above the fields. */
  error?: string
  publishing: boolean
  /** The event to start on, such as the one whose page the form was opened from. */
  event?: string
  /** Where Cancel goes. */
  cancelTo: string
}

/**
 * The publish form, posting `event` with the send form's data and options to the route that draws
 * it. Shared, so a Pro build draws the same form over an action of its own.
 */
export function PublishForm ({ error, publishing, event = '', cancelTo }: PublishFormProps) {
  const [dirty, setDirty] = useState(false)

  return (
    <>
      <LeaveGuard dirty={dirty && !publishing} unsaved="The event hasn't been published." />

      <Card>
        <CardHeader>
          <CardTitle>Event details</CardTitle>
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

            <Field id="event" label="Event" hint="Each queue subscribed to this event gets one job.">
              <input type="text" id="event" name="event" required defaultValue={event} className={cn(inputClass, 'font-mono')} />
            </Field>

            <JobFields dataHint="Optional. A JSON object each job carries as its data." />

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={publishing}>
                {publishing ? 'Publishing…' : 'Publish'}
              </Button>
              <SchemaLink to={cancelTo} className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                Cancel
              </SchemaLink>
            </div>
          </Form>
        </CardContent>
      </Card>
    </>
  )
}
