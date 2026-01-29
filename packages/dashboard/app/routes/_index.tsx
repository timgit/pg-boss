import { DbLink } from '~/components/db-link'
import type { Route } from './+types/_index'
import {
  getWarnings,
  getAggregateStats,
  getProblemQueues,
  getQueueCount,
  getProblemQueuesCount,
  getPartitionedQueuesCount,
} from '~/lib/queries.server'
import { StatsCards } from '~/components/stats-cards'
import { QueueStatsCards } from '~/components/queue-stats-cards'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { ErrorCard } from '~/components/error-card'
import {
  formatTimeAgo,
  WARNING_TYPE_VARIANTS,
  WARNING_TYPE_LABELS,
  cn,
} from '~/lib/utils'
import type { WarningType, QueueResult, WarningResult } from '~/lib/types'

export async function loader ({ context }: Route.LoaderArgs) {
  const [warnings, stats, problemQueues, totalQueues, problemQueuesCount, partitionedQueues] = await Promise.all([
    getWarnings(context.DB_URL, context.SCHEMA, { limit: 5 }),
    getAggregateStats(context.DB_URL, context.SCHEMA),
    getProblemQueues(context.DB_URL, context.SCHEMA, 5),
    getQueueCount(context.DB_URL, context.SCHEMA),
    getProblemQueuesCount(context.DB_URL, context.SCHEMA),
    getPartitionedQueuesCount(context.DB_URL, context.SCHEMA),
  ])

  return {
    stats,
    warnings,
    problemQueues,
    queueStats: {
      totalQueues,
      problemQueues: problemQueuesCount,
      partitionedQueues,
    },
  }
}

export function ErrorBoundary () {
  return <ErrorCard title="Failed to load dashboard" />
}

export default function Overview ({ loaderData }: Route.ComponentProps) {
  const { stats, warnings, problemQueues, queueStats } = loaderData

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
          Queues
        </h2>
        <QueueStatsCards
          totalQueues={queueStats.totalQueues}
          problemQueues={queueStats.problemQueues}
          partitionedQueues={queueStats.partitionedQueues}
        />
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Jobs Overview
        </h2>
        <StatsCards stats={stats} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Problem Queues */}
        <Card>
          <CardHeader>
            <CardTitle>Queues Needing Attention</CardTitle>
          </CardHeader>
          <CardContent>
            {problemQueues.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                All queues are healthy
              </p>
            ) : (
              <ul className="space-y-3">
                {problemQueues.map((queue: QueueResult) => (
                  <li key={queue.name}>
                    <DbLink
                      to={`/queues/${encodeURIComponent(queue.name)}`}
                      className={cn(
                        'flex items-center justify-between p-3 rounded-lg transition-colors',
                        'bg-error-50 hover:bg-error-100',
                        'dark:bg-error-950 dark:hover:bg-error-900'
                      )}
                    >
                      <div>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{queue.name}</p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {queue.queuedCount.toLocaleString()} queued (threshold: {queue.warningQueued.toLocaleString()})
                        </p>
                      </div>
                      <Badge variant="error">High Backlog</Badge>
                    </DbLink>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent Warnings */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Warnings</CardTitle>
            <DbLink
              to="/warnings"
              className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-gray-400 dark:hover:text-gray-300"
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
                    <WarningIcon className="w-5 h-5 text-warning-500 flex-shrink-0 mt-0.5" />
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
