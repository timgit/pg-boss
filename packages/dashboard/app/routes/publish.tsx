import { redirect, useActionData, useNavigation, useSearchParams, type RouterContextProvider } from 'react-router'
import { ErrorCard } from '~/components/error-card'
import { PublishForm } from '~/components/publish-form'
import { Card, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { dbContext } from '~/lib/db-context'
import type { TitleHandle } from '~/lib/page-title'
import { parsePublishForm } from '~/lib/publish-form'
import { publishEvent, publishedJobsHref } from '~/lib/publish.server'
import { READ_ONLY_MESSAGE, isReadOnly } from '~/lib/read-only.server'

export const handle: TitleHandle = { title: 'Publish event' }

// Typed by hand rather than from `./+types/publish`: a Pro build replaces this route with its own,
// React Router then generates no types for it, and the build still typechecks this file.

export function loader () {
  return { readOnly: isReadOnly() ? READ_ONLY_MESSAGE : null }
}

// Read-only mode refuses the post before it gets here, and in a Pro build Pro answers this URL itself.
export async function action ({ request, context }: { request: Request, context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const parsed = parsePublishForm(await request.formData())

  if ('error' in parsed) return { error: parsed.error }

  const published = await publishEvent(DB_URL, SCHEMA, parsed.value)
  if ('error' in published) return { error: published.error }

  return redirect(publishedJobsHref(published.queues, new URL(request.url).searchParams.get('schema')))
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Error loading the publish form"
      error={error}
      backTo={{ href: '/subscriptions', label: 'Back to Subscriptions' }}
    />
  )
}

export default function PublishEvent ({ loaderData }: { loaderData: ReturnType<typeof loader> }) {
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const [searchParams] = useSearchParams()
  const event = searchParams.get('event') ?? ''
  const parent = event
    ? { to: `/subscriptions/${encodeURIComponent(event)}`, label: event }
    : { to: '/subscriptions', label: 'Subscriptions' }

  if (loaderData.readOnly) {
    return (
      <div className="space-y-6">
        <PageHeader parent={parent} title="Publish event" />
        <Card>
          <CardContent>
            <p className="text-sm text-[var(--text-secondary)]">{loaderData.readOnly} Publishing events is turned off.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader parent={parent} title="Publish event" />
      <PublishForm
        error={actionData && 'error' in actionData ? actionData.error : undefined}
        publishing={navigation.state === 'submitting'}
        event={event}
        cancelTo={parent.to}
      />
    </div>
  )
}
