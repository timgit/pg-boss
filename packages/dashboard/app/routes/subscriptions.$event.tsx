import type { Route } from './+types/subscriptions.$event'
import { getSubscription } from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { DbLink } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { formatDate } from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => params.event ?? null }

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const queues = await getSubscription(DB_URL, SCHEMA, params.event)

  // An event with no queue subscribed to it is not a subscription at all.
  if (queues.length === 0) {
    throw new Response('No queue is subscribed to this event.', { status: 404, statusText: 'Not found' })
  }

  return { event: params.event, queues }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Failed to load the subscription" error={error} backTo={{ href: '/subscriptions', label: 'Back to subscriptions' }} />
}

const linkClass = 'font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'

export default function SubscriptionDetail ({ loaderData }: Route.ComponentProps) {
  const { event, queues } = loaderData

  return (
    <div className="space-y-4">
      <PageHeader
        parent={{ to: '/subscriptions', label: 'Subscriptions' }}
        title={`Subscription: ${event}`}
        subtitle={`Each job published to this event is sent to ${queues.length === 1 ? 'one queue' : `all ${queues.length} queues below`}`}
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
