import { useSearchParams } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues._index'
import { getQueues, getQueueCount } from '~/lib/queries.server'
import { Card, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '~/components/ui/table'
import { formatTimeAgo, parsePageNumber, cn } from '~/lib/utils'
import type { QueueResult } from '~/lib/types'

export async function loader ({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const page = parsePageNumber(url.searchParams.get('page'))
  const limit = 50
  const offset = (page - 1) * limit

  const [queues, totalCount] = await Promise.all([
    getQueues(context.DB_URL, context.SCHEMA, { limit, offset }),
    getQueueCount(context.DB_URL, context.SCHEMA),
  ])

  const totalPages = Math.ceil(totalCount / limit)
  const hasNextPage = queues.length === limit
  const hasPrevPage = page > 1

  return { queues, totalCount, page, totalPages, hasNextPage, hasPrevPage }
}

export function ErrorBoundary () {
  return (
    <div className="p-6">
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-error-600 dark:text-error-400 font-medium">Failed to load queues</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            Please check your database connection and try again.
          </p>
          <DbLink
            to="/"
            className="inline-block mt-4 text-primary-600 hover:text-primary-700 dark:text-gray-400 dark:hover:text-gray-300"
          >
            Back to Dashboard
          </DbLink>
        </CardContent>
      </Card>
    </div>
  )
}

export default function QueuesIndex ({ loaderData }: Route.ComponentProps) {
  const { queues, totalCount, page, totalPages, hasNextPage, hasPrevPage } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams)
    params.set('page', newPage.toString())
    setSearchParams(params)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Queues</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {totalCount.toLocaleString()} queue{totalCount !== 1 ? 's' : ''} configured
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Policy</TableHead>
                <TableHead className="text-right">Queued</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Deferred</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Last Monitored</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-gray-500 dark:text-gray-400 py-8" colSpan={8}>
                    No queues found
                  </TableCell>
                </TableRow>
              ) : (
                queues.map((queue: QueueResult) => {
                  const hasBacklog =
                    queue.warningQueued > 0 &&
                    queue.queuedCount > queue.warningQueued

                  return (
                    <TableRow key={queue.name}>
                      <TableCell>
                        <DbLink
                          to={`/queues/${encodeURIComponent(queue.name)}`}
                          className="font-medium text-primary-600 hover:text-primary-700 dark:text-gray-400 dark:hover:text-gray-300"
                        >
                          {queue.name}
                        </DbLink>
                      </TableCell>
                      <TableCell>
                        <Badge variant="gray" size="sm">
                          {queue.policy}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.queuedCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.activeCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.deferredCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.totalCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-gray-500 dark:text-gray-400">
                        {queue.monitorOn
                          ? formatTimeAgo(new Date(queue.monitorOn))
                          : 'Never'}
                      </TableCell>
                      <TableCell>
                        {hasBacklog ? (
                          <Badge variant="error" size="sm" dot>
                            High Backlog
                          </Badge>
                        ) : queue.activeCount > 0 ? (
                          <Badge variant="success" size="sm" dot>
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="gray" size="sm" dot>
                            Idle
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className={cn(
            'flex items-center justify-between px-6 py-4 border-t',
            'border-gray-200 dark:border-gray-800'
          )}>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Page {page} of {totalPages}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page - 1)}
                disabled={!hasPrevPage}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page + 1)}
                disabled={!hasNextPage}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
