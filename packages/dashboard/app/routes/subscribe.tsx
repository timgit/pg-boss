import { redirect, useActionData, useNavigation, useSearchParams, type RouterContextProvider } from 'react-router'
import { resolveSchemaHref } from '~/components/schema-link'
import { ErrorCard } from '~/components/error-card'
import { SubscriptionForm } from '~/components/subscription-form'
import { Card, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { schemaContext } from '~/lib/schema-context'
import type { TitleHandle } from '~/lib/page-title'
import { READ_ONLY_MESSAGE, isReadOnly } from '~/lib/read-only.server'
import { parseSubscriptionForm } from '~/lib/subscription-form'
import { subscribeQueue } from '~/lib/subscription.server'

export const handle: TitleHandle = { title: 'New subscription' }

// Typed by hand rather than from `./+types/subscribe`: a Pro build replaces this route with
// its own, React Router then generates no types for it, and the build still typechecks this file.

export function loader () {
  return { readOnly: isReadOnly() ? READ_ONLY_MESSAGE : null }
}

// Read-only mode refuses the post before it gets here, and in a Pro build Pro answers this URL itself.
export async function action ({ request, context }: { request: Request, context: Readonly<RouterContextProvider> }) {
  const { connection } = context.get(schemaContext)
  const parsed = parseSubscriptionForm(await request.formData())

  if ('error' in parsed) return { error: parsed.error }

  const subscribed = await subscribeQueue(connection.url, connection.schema, parsed.value)
  if ('error' in subscribed) return { error: subscribed.error }

  const schema = new URL(request.url).searchParams.get('schema')
  return redirect(resolveSchemaHref(`/subscriptions/${encodeURIComponent(parsed.value.event)}`, schema))
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Error loading the new subscription form"
      error={error}
      backTo={{ href: '/subscriptions', label: 'Back to Subscriptions' }}
    />
  )
}

export default function NewSubscription ({ loaderData }: { loaderData: ReturnType<typeof loader> }) {
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
        <PageHeader parent={parent} title="New subscription" />
        <Card>
          <CardContent>
            <p className="text-sm text-[var(--text-secondary)]">{loaderData.readOnly} Subscribing queues is turned off.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader parent={parent} title="New subscription" />
      <SubscriptionForm
        error={actionData && 'error' in actionData ? actionData.error : undefined}
        saving={navigation.state === 'submitting'}
        event={event}
        queue={searchParams.get('queue') ?? ''}
        cancelTo={parent.to}
      />
    </div>
  )
}
