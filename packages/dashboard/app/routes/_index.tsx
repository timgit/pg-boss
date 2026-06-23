import { DbLink } from '~/components/db-link'
import type { Route } from './+types/_index'
import {
  getWarnings,
  getQueueStats,
  getTopQueues,
  getQueueCount,
  getProblemQueuesCount,
  getBamStatusSummary,
} from '~/lib/queries.server'
import { StatsCards } from '~/components/stats-cards'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
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
import { ErrorCard } from '~/components/error-card'
import {
  formatTimeAgo,
  WARNING_TYPE_VARIANTS,
  WARNING_TYPE_LABELS,
} from '~/lib/utils'
import type { WarningType, QueueResult, WarningResult } from '~/lib/types'
import { dbContext } from '~/lib/db-context'

export async function loader ({ context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const [warnings, stats, topQueues, totalQueues, problemQueuesCount, bamSummary] = await Promise.all([
    getWarnings(DB_URL, SCHEMA, { limit: 5 }),
    getQueueStats(DB_URL, SCHEMA),
    getTopQueues(DB_URL, SCHEMA, 5),
    getQueueCount(DB_URL, SCHEMA),
    getProblemQueuesCount(DB_URL, SCHEMA),
    getBamStatusSummary(DB_URL, SCHEMA),
  ])

  // Reduce the BAM summary to the counts the overview card needs.
  const migrations = bamSummary.reduce(
    (acc, row) => {
      if (row.status === 'pending') acc.pending += row.count
      else if (row.status === 'in_progress') acc.inProgress += row.count
      else if (row.status === 'failed') acc.failed += row.count
      return acc
    },
    { pending: 0, inProgress: 0, failed: 0 }
  )

  return {
    stats,
    warnings,
    topQueues,
    migrations,
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
  const { stats, warnings, topQueues, migrations } = loaderData

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Monitor your pg-boss job queues"
        action={
          <DbLink to="/send">
            <Button variant="primary" size="md">Send Job</Button>
          </DbLink>
        }
      />

      {/* Stat row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatsCards stats={stats} />
      </div>

      <MigrationsBanner migrations={migrations} />

      {/* Two column: top queues + recent warnings */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Top Queues</CardTitle>
            <DbLink
              to="/queues"
              className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              View all
            </DbLink>
          </CardHeader>
          {topQueues.length === 0 ? (
            <p className="text-sm text-[var(--text-tertiary)] p-5">No queues found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Queued</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                  <TableHead>Status</TableHead>
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
                    <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                      {queue.queuedCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                      {queue.activeCount.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <QueueStatusBadge queue={queue} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {/* Recent Warnings */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Warnings</CardTitle>
            <DbLink
              to="/warnings"
              className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              View all
            </DbLink>
          </CardHeader>
          <div className="flex flex-col gap-2 p-3">
            {warnings.length === 0 ? (
              <p className="text-sm text-[var(--text-tertiary)] p-2">No warnings recorded</p>
            ) : (
              warnings.map((warning: WarningResult) => (
                <div
                  key={warning.id}
                  className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-[var(--surface-sunken)]"
                >
                  <WarningIcon className="w-[18px] h-[18px] text-[var(--warning-500)] flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge
                        variant={WARNING_TYPE_VARIANTS[warning.type as WarningType]}
                        size="sm"
                      >
                        {WARNING_TYPE_LABELS[warning.type as WarningType]}
                      </Badge>
                      <span className="text-[11px] text-[var(--text-tertiary)] pgb-num">
                        {formatTimeAgo(new Date(warning.createdOn))}
                      </span>
                    </div>
                    <p className="text-sm text-[var(--text-secondary)] truncate">
                      {warning.message}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function MigrationsBanner ({
  migrations,
}: {
  migrations: { pending: number; inProgress: number; failed: number }
}) {
  const { pending, inProgress, failed } = migrations
  // Nothing in flight or failed — keep the overview uncluttered. The dedicated
  // Migrations page is always reachable from the sidebar.
  if (pending === 0 && inProgress === 0 && failed === 0) return null

  const parts: string[] = []
  if (pending > 0) parts.push(`${pending.toLocaleString()} pending`)
  if (inProgress > 0) parts.push(`${inProgress.toLocaleString()} in progress`)
  if (failed > 0) parts.push(`${failed.toLocaleString()} failed`)

  return (
    <DbLink to="/migrations" className="block mb-4">
      <Card className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-hover)]">
        <Badge variant={failed > 0 ? 'error' : 'warning'} size="sm" dot>
          Async migrations
        </Badge>
        <span className="text-sm text-[var(--text-secondary)]">{parts.join(' · ')}</span>
        <span className="ml-auto text-sm font-medium text-primary-600 dark:text-primary-400">
          View
        </span>
      </Card>
    </DbLink>
  )
}

function QueueStatusBadge ({ queue }: { queue: QueueResult }) {
  const hasBacklog =
    (queue.warningQueueSize ?? 0) > 0 && queue.queuedCount > (queue.warningQueueSize ?? 0)
  if (hasBacklog) return <Badge variant="error" size="sm" dot>Backlogged</Badge>
  if (queue.activeCount > 0) return <Badge variant="success" size="sm" dot>Processing</Badge>
  return <Badge variant="gray" size="sm" dot>Idle</Badge>
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
