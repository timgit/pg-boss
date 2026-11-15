import { useState } from 'react'
import { redirect, useActionData, useNavigation, useSearchParams, type RouterContextProvider } from 'react-router'
import { SchemaLink, resolveSchemaHref } from '~/components/schema-link'
import { ErrorCard } from '~/components/error-card'
import { Field } from '~/components/form-field'
import { JobFields } from '~/components/job-fields'
import { LeaveGuard } from '~/components/leave-guard'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { QueueSelect } from '~/components/ui/queue-select'
import { schemaContext } from '~/lib/schema-context'
import type { TitleHandle } from '~/lib/page-title'
import { READ_ONLY_MESSAGE, isReadOnly } from '~/lib/read-only.server'
import { parseSendForm } from '~/lib/send-form'
import { sendJob } from '~/lib/send-job.server'

export const handle: TitleHandle = { title: 'Send job' }

// Typed by hand rather than from `./+types/send`: a Pro build replaces this route with its own send
// form, React Router then generates no types for it, and the build still typechecks this file.

export function loader () {
  return { readOnly: isReadOnly() ? READ_ONLY_MESSAGE : null }
}

// Read-only mode refuses the post before it gets here, and in a Pro build Pro answers /send itself.
export async function action ({ request, context }: { request: Request, context: Readonly<RouterContextProvider> }) {
  const { connection } = context.get(schemaContext)
  const parsed = parseSendForm(await request.formData())

  if ('error' in parsed) return { error: parsed.error }

  const sent = await sendJob(connection.url, connection.schema, parsed.value)
  if ('error' in sent) return { error: sent.error }

  const schema = new URL(request.url).searchParams.get('schema')
  return redirect(resolveSchemaHref(`/queues/${encodeURIComponent(parsed.value.queue)}`, schema))
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

            <JobFields />

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={sending || !queue}>
                {sending ? 'Sending…' : 'Send job'}
              </Button>
              <SchemaLink to="/queues" className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                Cancel
              </SchemaLink>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
