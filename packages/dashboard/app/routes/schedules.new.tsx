import { useState } from 'react'
import { redirect, useActionData, useNavigation, type RouterContextProvider } from 'react-router'
import { DbLink, resolveDbHref } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { Field, inputClass } from '~/components/form-field'
import { LeaveGuard } from '~/components/leave-guard'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { QueueSelect } from '~/components/ui/queue-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { dbContext } from '~/lib/db-context'
import type { TitleHandle } from '~/lib/page-title'
import { READ_ONLY_MESSAGE, isReadOnly } from '~/lib/read-only.server'
import { parseScheduleForm } from '~/lib/schedule-form'
import { createSchedule } from '~/lib/schedule-job.server'
import { cn } from '~/lib/utils'

export const handle: TitleHandle = { title: 'New schedule' }

// Typed by hand rather than from `./+types/schedules.new`: a Pro build replaces this route with its
// own form, React Router then generates no types for it, and the build still typechecks this file.

export function loader () {
  return { readOnly: isReadOnly() ? READ_ONLY_MESSAGE : null }
}

// Read-only mode refuses the post before it gets here, and in a Pro build Pro answers this URL itself.
export async function action ({ request, context }: { request: Request, context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const parsed = parseScheduleForm(await request.formData())

  if ('error' in parsed) return { error: parsed.error }

  const created = await createSchedule(DB_URL, SCHEMA, parsed.value)
  if ('error' in created) return { error: created.error }

  const key = typeof parsed.value.options?.key === 'string' ? parsed.value.options.key : '__default__'
  const schema = new URL(request.url).searchParams.get('schema')
  return redirect(resolveDbHref(`/schedules/${encodeURIComponent(parsed.value.queue)}/${encodeURIComponent(key)}`, schema))
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Error loading the new schedule form"
      error={error}
      backTo={{ href: '/schedules', label: 'Back to Schedules' }}
    />
  )
}

const MISSED = [
  { value: 'skip', label: 'Skip: send nothing for occurrences missed' },
  { value: 'once', label: 'Once: send one job for the latest occurrence missed' },
]

export default function NewSchedule ({ loaderData }: { loaderData: ReturnType<typeof loader> }) {
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const saving = navigation.state === 'submitting'
  const [dirty, setDirty] = useState(false)
  const [queue, setQueue] = useState('')

  if (loaderData.readOnly) {
    return (
      <div className="space-y-6">
        <PageHeader parent={{ to: '/schedules', label: 'Schedules' }} title="New schedule" />
        <Card>
          <CardContent>
            <p className="text-sm text-[var(--text-secondary)]">{loaderData.readOnly} Adding schedules is turned off.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <LeaveGuard dirty={dirty && !saving} unsaved="The schedule hasn't been added." />

      <PageHeader parent={{ to: '/schedules', label: 'Schedules' }} title="New schedule" />

      <Card>
        <CardHeader>
          <CardTitle>Schedule details</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            className="space-y-5"
            onChange={() => setDirty(true)}
            onSubmit={() => setDirty(false)}
          >
            {actionData && 'error' in actionData && (
              <div role="alert" className="rounded-lg border border-[var(--state-failed-border)] bg-[var(--state-failed-bg)] px-4 py-3 text-sm text-[var(--state-failed-fg)]">
                {actionData.error}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="queueName" label="Queue">
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
              <Field id="key" label="Key" hint="Optional. Tells apart several schedules on one queue.">
                <input type="text" id="key" name="key" className={inputClass} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="cron" label="Expression" hint="Cron (minute hour day month weekday), or a recurrence rule such as FREQ=DAILY;BYHOUR=8.">
                <input type="text" id="cron" name="cron" required placeholder="0 8 * * *" className={cn(inputClass, 'font-mono')} />
              </Field>
              <Field id="timezone" label="Timezone" hint="Optional. An IANA timezone, such as America/New_York.">
                <input type="text" id="timezone" name="timezone" placeholder="UTC" className={inputClass} />
              </Field>
            </div>

            <Field id="data" label="Data" hint="Optional. A JSON object each job carries as its data.">
              <textarea id="data" name="data" rows={4} placeholder='{"key": "value"}' className={cn(inputClass, 'font-mono')} />
            </Field>

            <Field id="missed" label="Missed occurrences" hint="What the schedule sends for occurrences that came due while nothing was running it.">
              <Select name="missed" defaultValue="skip" items={MISSED} onValueChange={() => setDirty(true)}>
                <SelectTrigger id="missed" variant="field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MISSED.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field id="priority" label="Priority">
                <input type="number" id="priority" name="priority" placeholder="0" className={inputClass} />
              </Field>
              <Field id="retryLimit" label="Retry limit">
                <input type="number" id="retryLimit" name="retryLimit" min="0" placeholder="The queue's" className={inputClass} />
              </Field>
              <Field id="expireInSeconds" label="Expire in seconds">
                <input type="number" id="expireInSeconds" name="expireInSeconds" min="1" placeholder="The queue's" className={inputClass} />
              </Field>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={saving || !queue}>
                {saving ? 'Adding…' : 'Add schedule'}
              </Button>
              <DbLink to="/schedules" className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                Cancel
              </DbLink>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
