import { DbLink } from '~/components/db-link'
import { ProSlot } from '~/components/pro-slot'
import type { Route } from './+types/subscriptions'
import {
  getSubscriptions,
  getSubscriptionEventCount,
} from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableHeader,
} from '~/components/ui/table'
import { TablePagination } from '~/components/table-pagination'
import { PAGE_SIZE, pageWindow, pageInfo } from '~/lib/pagination'
import { ErrorCard } from '~/components/error-card'
import { dbContext } from '~/lib/db-context'
import { formatDate } from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Subscriptions' }

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const { page, limit, offset } = pageWindow(url, PAGE_SIZE)
  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')
  const queue = url.searchParams.get('queue') || null

  const [subscriptions, totalCount] = await Promise.all([
    getSubscriptions(DB_URL, SCHEMA, { queue, limit, offset, sort, dir }),
    getSubscriptionEventCount(DB_URL, SCHEMA, queue),
  ])

  return {
    subscriptions,
    queue,
    totalCount,
    pageSize: PAGE_SIZE,
    ...pageInfo(page, PAGE_SIZE, subscriptions.length, totalCount),
  }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Failed to load subscriptions" error={error} />
}

const queueLinkClass = 'font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'

export default function Subscriptions ({ loaderData }: Route.ComponentProps) {
  const { subscriptions, queue, totalCount, pageSize, page, totalPages, hasNextPage, hasPrevPage } = loaderData

  return (
    <div className="space-y-4">
      <PageHeader
        title="Subscriptions"
        subtitle="Events sent with publish(), and the queues subscribed to each"
        action={<ProSlot name="pageActions" page="subscriptions" />}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            {queue
              ? <>Events <DbLink to={`/queues/${encodeURIComponent(queue)}`} className={queueLinkClass}>{queue}</DbLink> is subscribed to</>
              : 'All events'}
          </CardTitle>
          <span className="flex items-center gap-3 text-xs text-[var(--text-tertiary)]">
            {queue && (
              <DbLink to="/subscriptions" className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300">
                Show all events
              </DbLink>
            )}
            <span className="pgb-num">{totalCount.toLocaleString()} total</span>
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader column="event">Event</SortableHeader>
                <TableHead>Subscribed queues</TableHead>
                <SortableHeader column="queues">Queues</SortableHeader>
                <SortableHeader column="updated">Last subscribed</SortableHeader>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={4}>
                    {queue ? `${queue} is not subscribed to any events` : 'No subscriptions found'}
                  </TableCell>
                </TableRow>
              ) : (
                subscriptions.map((subscription) => (
                  <TableRow key={subscription.event} to={`/subscriptions/${encodeURIComponent(subscription.event)}`}>
                    <TableCell className="font-medium font-mono text-xs">
                      <DbLink to={`/subscriptions/${encodeURIComponent(subscription.event)}`} className={queueLinkClass}>
                        {subscription.event}
                      </DbLink>
                    </TableCell>
                    {/* Names only: a queue is a link on the event's own page, where the row has one job. */}
                    <TableCell className="whitespace-normal">
                      <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-[var(--text-secondary)]">
                        {subscription.queues.map((name) => <span key={name}>{name}</span>)}
                      </span>
                    </TableCell>
                    <TableCell className="pgb-num text-[var(--text-secondary)]">
                      {subscription.queues.length.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-[var(--text-secondary)]">
                      {formatDate(new Date(subscription.updatedOn))}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        {totalCount > 0 && (
          <TablePagination
            page={page}
            totalPages={totalPages}
            hasNextPage={hasNextPage}
            hasPrevPage={hasPrevPage}
            totalCount={totalCount}
            pageSize={pageSize}
          />
        )}
      </Card>
    </div>
  )
}
