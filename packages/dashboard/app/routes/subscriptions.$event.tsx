import { redirect } from 'react-router'
import type { Route } from './+types/subscriptions.$event'
import { getSubscription } from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { unsubscribeQueue } from '~/lib/subscription.server'
import { SubscriptionActions, SubscriptionRowActions, useSubscriptionRowActions } from '~/components/subscription-actions'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { DbLink, resolveDbHref } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { formatDate } from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => (params.event ? `Subscription: ${params.event}` : null) }

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const queues = await getSubscription(DB_URL, SCHEMA, params.event)

  // An event with no queue subscribed to it is not a subscription at all.
  if (queues.length === 0) {
    throw new Response('No queue is subscribed to this event.', { status: 404, statusText: 'Not found' })
  }

  return { event: params.event, queues }
}

// Read-only mode refuses the post before it gets here. In a Pro build, Pro's Unsubscribe posts to a
// route of its own, which checks the role and records the change.
export async function action ({ params, request, context }: Route.ActionArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const form = await request.formData()
  const queue = form.get('queue')

  if (form.get('intent') !== 'unsubscribe' || typeof queue !== 'string' || !queue) return { error: 'Unknown action' }

  const removed = await unsubscribeQueue(DB_URL, SCHEMA, { event: params.event, queue })
  if ('error' in removed) return { error: removed.error }

  // The last queue gone leaves no subscription, and no page for it.
  if ((await getSubscription(DB_URL, SCHEMA, params.event)).length === 0) {
    return redirect(resolveDbHref('/subscriptions', new URL(request.url).searchParams.get('schema')))
  }

  return { ok: true }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Error loading the subscription" error={error} backTo={{ href: '/subscriptions', label: 'Back to subscriptions' }} />
}

const linkClass = 'font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'

export default function SubscriptionDetail ({ loaderData }: Route.ComponentProps) {
  const { event, queues } = loaderData
  const withActions = useSubscriptionRowActions()

  return (
    <div className="space-y-4">
      <PageHeader
        parent={{ to: '/subscriptions', label: 'Subscriptions' }}
        title={`Subscription: ${event}`}
        subtitle={`Sends each published job to ${queues.length === 1 ? 'one queue' : `${queues.length} queues`}`}
        action={<SubscriptionActions event={event} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Subscribed queues</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>Subscribed</TableHead>
                <TableHead>Updated</TableHead>
                {withActions && <TableHead><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.map((queue) => (
                <TableRow key={queue.name} to={`/queues/${encodeURIComponent(queue.name)}`}>
                  <TableCell>
                    <DbLink to={`/queues/${encodeURIComponent(queue.name)}`} className={linkClass}>{queue.name}</DbLink>
                  </TableCell>
                  <TableCell className="text-[var(--text-secondary)]">{formatDate(new Date(queue.createdOn))}</TableCell>
                  <TableCell className="text-[var(--text-secondary)]">{formatDate(new Date(queue.updatedOn))}</TableCell>
                  {withActions && (
                    <TableCell className="text-right">
                      <SubscriptionRowActions event={event} queue={queue.name} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
