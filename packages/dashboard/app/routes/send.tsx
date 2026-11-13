import { useState } from 'react'
import { redirect, useActionData, useNavigation, useSearchParams, type RouterContextProvider } from 'react-router'
import { DbLink, resolveDbHref } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { Field, inputClass } from '~/components/form-field'
import { LeaveGuard } from '~/components/leave-guard'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { QueueSelect } from '~/components/ui/queue-select'
import { dbContext } from '~/lib/db-context'
import type { TitleHandle } from '~/lib/page-title'
import { READ_ONLY_MESSAGE, isReadOnly } from '~/lib/read-only.server'
import { parseSendForm } from '~/lib/send-form'
import { sendJob } from '~/lib/send-job.server'
import { cn } from '~/lib/utils'

export const handle: TitleHandle = { title: 'Send job' }

// Typed by hand rather than from `./+types/send`: a Pro build replaces this route with its own send
// form, React Router then generates no types for it, and the build still typechecks this file.

export function loader () {
  return { readOnly: isReadOnly() ? READ_ONLY_MESSAGE : null }
}

// Read-only mode refuses the post before it gets here, and in a Pro build Pro answers /send itself.
export async function action ({ request, context }: { request: Request, context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const parsed = parseSendForm(await request.formData())

  if ('error' in parsed) return { error: parsed.error }

  const sent = await sendJob(DB_URL, SCHEMA, parsed.value)
  if ('error' in sent) return { error: sent.error }

  const schema = new URL(request.url).searchParams.get('schema')
  return redirect(resolveDbHref(`/queues/${encodeURIComponent(parsed.value.queue)}`, schema))
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Error loading the send page"
      error={error}
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function SendJob ({ loaderData }: { loaderData: ReturnType<typeof loader> }) {
  const [searchParams] = useSearchParams()
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const sending = navigation.state === 'submitting'
  const [dirty, setDirty] = useState(false)
  // `?queue=` from a queue's page starts the form on that queue.
  const [queue, setQueue] = useState(searchParams.get('queue') ?? '')

  if (loaderData.readOnly) {
    return (
      <div className="space-y-6">
        <PageHeader parent={{ to: '/queues', label: 'Queues' }} title="Send job" />
        <Card>
          <CardContent>
            <p className="text-sm text-[var(--text-secondary)]">{loaderData.readOnly} Sending jobs is turned off.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <LeaveGuard dirty={dirty && !sending} unsaved="The job hasn't been sent." />

      <PageHeader parent={{ to: '/queues', label: 'Queues' }} title="Send job" />

      <Card>
        <CardHeader>
          <CardTitle>Job details</CardTitle>
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

            <Field id="data" label="Data" hint="Optional. A JSON object the job carries as its data.">
              <textarea id="data" name="data" rows={6} placeholder='{"key": "value"}' className={cn(inputClass, 'font-mono')} />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="priority" label="Priority">
                <input type="number" id="priority" name="priority" placeholder="0" className={inputClass} />
              </Field>
              <Field id="startAfter" label="Start after">
                <input type="text" id="startAfter" name="startAfter" placeholder="2026-01-01T00:00:00Z, or seconds" className={inputClass} />
              </Field>
              <Field id="singletonKey" label="Singleton key">
                <input type="text" id="singletonKey" name="singletonKey" placeholder="Optional" className={inputClass} />
              </Field>
              <Field id="retryLimit" label="Retry limit">
                <input type="number" id="retryLimit" name="retryLimit" min="0" placeholder="The queue's" className={inputClass} />
              </Field>
              <Field id="expireInSeconds" label="Expire in seconds">
                <input type="number" id="expireInSeconds" name="expireInSeconds" min="1" placeholder="The queue's" className={inputClass} />
              </Field>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={sending || !queue}>
                {sending ? 'Sending…' : 'Send job'}
              </Button>
              <DbLink to="/queues" className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                Cancel
              </DbLink>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
