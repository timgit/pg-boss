import { DbLink } from '~/components/db-link'
import type { Route } from './+types/_index'
import {
  getWarnings,
  getAggregateStats,
  getTopQueues,
  getQueueCount,
  getProblemQueuesCount,
} from '~/lib/queries.server'
import { StatsCards } from '~/components/stats-cards'
import { QueueStatsCards } from '~/components/queue-stats-cards'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '~/components/ui/table'
import { ErrorCard } from '~/components/error-card'
import {
  formatTimeAgo,
  WARNING_TYPE_VARIANTS,
  WARNING_TYPE_LABELS,
  cn,
} from '~/lib/utils'
import type { WarningType, QueueResult, WarningResult } from '~/lib/types'

export async function loader ({ context }: Route.LoaderArgs) {
  const [warnings, stats, topQueues, totalQueues, problemQueuesCount] = await Promise.all([
    getWarnings(context.DB_URL, context.SCHEMA, { limit: 5 }),
    getAggregateStats(context.DB_URL, context.SCHEMA),
    getTopQueues(context.DB_URL, context.SCHEMA, 5),
    getQueueCount(context.DB_URL, context.SCHEMA),
    getProblemQueuesCount(context.DB_URL, context.SCHEMA),
  ])

  return {
    stats,
    warnings,
    topQueues,
    queueStats: {
      totalQueues,
      problemQueues: problemQueuesCount,
    },
  }
}

export function ErrorBoundary () {
  return <ErrorCard title="Failed to load dashboard" />
}

export default function Overview ({ loaderData }: Route.ComponentProps) {
  const { stats, warnings, topQueues, queueStats } = loaderData

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Monitor your pg-boss job queues
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Overview
        </h2>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCards stats={stats} />
          <QueueStatsCards
            totalQueues={queueStats.totalQueues}
            problemQueues={queueStats.problemQueues}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Queues */}
        <Card>
          <CardHeader>
            <CardTitle>Top Queues</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {topQueues.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 p-6">
                No queues found
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right hidden md:table-cell">Queued</TableHead>
                    <TableHead className="text-right hidden md:table-cell">Active</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topQueues.map((queue: QueueResult) => (
                    <TableRow key={queue.name}>
                      <TableCell>
                        <DbLink
                          to={`/queues/${encodeURIComponent(queue.name)}`}
                          className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                        >
                          {queue.name}
                        </DbLink>
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300 hidden md:table-cell">
                        {queue.queuedCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300 hidden md:table-cell">
                        {queue.activeCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-gray-700 dark:text-gray-300">
                        {queue.totalCount.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Warnings */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Warnings</CardTitle>
            <DbLink
              to="/warnings"
              className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              View all
            </DbLink>
          </CardHeader>
          <CardContent>
            {warnings.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No warnings recorded
              </p>
            ) : (
              <ul className="space-y-3">
                {warnings.map((warning: WarningResult) => (
                  <li
                    key={warning.id}
                    className={cn(
                      'flex items-start gap-3 p-3 rounded-lg',
                      'bg-gray-50 dark:bg-gray-800'
                    )}
                  >
                    <WarningIcon className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          variant={WARNING_TYPE_VARIANTS[warning.type as WarningType]}
                          size="sm"
                        >
                          {WARNING_TYPE_LABELS[warning.type as WarningType]}
                        </Badge>
                        <span className="text-xs text-gray-400">
                          {formatTimeAgo(new Date(warning.createdOn))}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 dark:text-gray-300 truncate">
                        {warning.message}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function WarningIcon ({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
      />
    </svg>
  )
}
