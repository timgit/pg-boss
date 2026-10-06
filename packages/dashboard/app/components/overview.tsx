import { DbLink } from '~/components/db-link'
import { ProSlot } from '~/components/pro-slot'
import { StatsCards } from '~/components/stats-cards'
import { Card, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  CLICKABLE_ROW,
  useRowClick,
} from '~/components/ui/table'
import { Sparkline } from '~/components/ui/sparkline'
import {
  cn,
  formatTimeAgo,
  warningTypeVariant,
  warningTypeLabel,
} from '~/lib/utils'
import type { ComponentType, ReactNode } from 'react'
import type { QueueResult, WarningResult } from '~/lib/types'
import type { OverviewData } from '~/lib/overview.server'
import type { StatKey } from '~/components/stats-cards'

/** A column an overlay adds to the overview's queue table. */
export interface OverviewQueueColumn {
  header: string
  align?: 'right'
  cell: (queue: QueueResult) => ReactNode
}

/**
 * What an overlay that replaces the overview adds to the sections it composes. Every field is
 * optional, and without them the sections are the free overview's.
 */
export interface OverviewExtensions {
  /** A line under a stat card, by the figure it sits under. */
  statFooters?: Partial<Record<StatKey, ReactNode>>
  queues?: {
    title?: string
    /** Where the table's own link goes, and what it says. */
    more?: { to: string, text: string }
    afterName?: OverviewQueueColumn[]
    afterActive?: OverviewQueueColumn[]
    /** Leave out the status column, when a column added above says more. */
    hideStatus?: boolean
  }
  /** Under each recent warning. */
  WarningFooter?: ComponentType<{ warning: WarningResult }>
}

/** The overview's title and the overlay's actions beside it, for an overlay that replaces the page. */
export function OverviewHeader () {
  return (
    <PageHeader
      title="Overview"
      action={<ProSlot name="pageActions" page="overview" />}
    />
  )
}

/**
 * The overview's body: the migrations banner when there is one, the stat row, and top queues beside recent warnings.
 * `narrow` lays it out for a column beside something else, three stats to a row and the two cards
 * stacked. Exported so an overlay that replaces the page composes it rather than copying it.
 */
export function OverviewSections ({ data, narrow = false, extensions = {} }: { data: OverviewData, narrow?: boolean, extensions?: OverviewExtensions }) {
  const { stats, warnings, topQueues, migrations } = data
  const q = extensions.queues ?? {}
  const { WarningFooter } = extensions
  const headOf = (c: OverviewQueueColumn) => (
    <TableHead key={c.header} className={c.align === 'right' ? 'text-right' : undefined}>{c.header}</TableHead>
  )
  const cellOf = (queue: QueueResult) => (c: OverviewQueueColumn) => (
    <TableCell key={c.header} className={c.align === 'right' ? 'text-right pgb-num' : undefined}>{c.cell(queue)}</TableCell>
  )

  return (
    <div>
      {/* First, when there is one: migrations waiting, running or failed need somebody to look. */}
      <MigrationsBanner migrations={migrations} />

      {/* Stat row */}
      <div className={narrow
        ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 mb-4'
        : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-4'}
      >
        <StatsCards stats={stats} footers={extensions.statFooters} />
      </div>

      {/* Two column: top queues + recent warnings */}
      <div className={narrow ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4'}>
        <Card>
          <CardHeader>
            <CardTitle>{q.title ?? 'Top Queues'}</CardTitle>
            <DbLink
              to={q.more?.to ?? '/queues'}
              className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              {q.more?.text ?? 'View all'}
            </DbLink>
          </CardHeader>
          {topQueues.length === 0 ? (
            <p className="text-sm text-[var(--text-tertiary)] p-5">No queues found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  {q.afterName?.map(headOf)}
                  <TableHead className="text-right">Queued</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                  {q.afterActive?.map(headOf)}
                  <TableHead>Trend</TableHead>
                  {!q.hideStatus && <TableHead>Status</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {topQueues.map((queue: QueueResult) => (
                  <TableRow key={queue.name} to={`/queues/${encodeURIComponent(queue.name)}`}>
                    <TableCell>
                      <DbLink
                        to={`/queues/${encodeURIComponent(queue.name)}`}
                        className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                      >
                        {queue.name}
                      </DbLink>
                    </TableCell>
                    {q.afterName?.map(cellOf(queue))}
                    <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                      {queue.queuedCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right pgb-num text-[var(--text-primary)]">
                      {queue.activeCount.toLocaleString()}
                    </TableCell>
                    {q.afterActive?.map(cellOf(queue))}
                    <TableCell>
                      {queue.readyHistory && queue.readyHistory.length > 0 ? (
                        <Sparkline
                          // Stored newest-first; reverse to chronological (oldest → newest).
                          data={[...queue.readyHistory].reverse()}
                          width={96}
                          height={20}
                          color="var(--primary-600)"
                          showDot={false}
                          area
                          aria-label={`Ready count trend for ${queue.name}`}
                        />
                      ) : (
                        <span className="text-[var(--border-strong)]">—</span>
                      )}
                    </TableCell>
                    {!q.hideStatus && (
                      <TableCell>
                        <QueueStatusBadge queue={queue} />
                      </TableCell>
                    )}
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
                <WarningItem key={warning.id} id={warning.id}>
                  <WarningIcon className="w-[18px] h-[18px] text-[var(--warning-500)] flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge
                        variant={warningTypeVariant(warning.type)}
                        size="sm"
                      >
                        {warningTypeLabel(warning.type)}
                      </Badge>
                      <span className="text-[11px] text-[var(--text-tertiary)] pgb-num">
                        {formatTimeAgo(new Date(warning.createdOn))}
                      </span>
                    </div>
                    <DbLink to={`/warnings/${warning.id}`} className="block truncate text-sm text-[var(--text-secondary)] hover:underline">
                      {warning.message}
                    </DbLink>
                    {WarningFooter && <WarningFooter warning={warning} />}
                  </div>
                </WarningItem>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

/** One recent warning, opening its page from anywhere on it but the controls inside. */
function WarningItem ({ id, children }: { id: string, children: ReactNode }) {
  const onClick = useRowClick({ to: `/warnings/${id}` })
  return (
    <div onClick={onClick} className={cn('flex items-start gap-3 px-3 py-2.5 rounded-lg bg-[var(--surface-sunken)]', CLICKABLE_ROW, 'hover:bg-[var(--surface-hover)]')}>
      {children}
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
