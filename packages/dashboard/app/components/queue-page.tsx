import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { ChevronDown, ChevronRight, LineChart } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import { Sparkline } from '~/components/ui/sparkline'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { StatCard } from '~/components/ui/stat-card'
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
import { TablePagination } from '~/components/table-pagination'
import { FilterSelect } from '~/components/ui/filter-select'
import { JobColumnsEditor } from '~/components/job-columns-editor'
import { JobColumnCell } from '~/components/job-column-cell'
import type { JobResult, QueueResult } from '~/lib/types'
import { formatDate, JOB_STATE_OPTIONS, cn } from '~/lib/utils'
import {
  DEFAULT_QUEUE_JOB_COLUMNS,
  appendJobColumns,
  type JobColumn,
} from '~/lib/job-columns'
import type { QueuePageData } from '~/lib/queue-page.server'

/**
 * What an overlay that replaces a queue's page adds to the sections it composes. Every field is
 * optional, and without them the page is the free one.
 */
export interface QueuePageExtensions {
  /** In the header, before the overlay's queue actions and View metrics. */
  actions?: ReactNode
  /** Between the header and the counts. */
  afterHeader?: ReactNode
  /** At the end of the page, under the jobs. */
  below?: ReactNode
}

const metricsPath = (name: string) => `/queues/${encodeURIComponent(name)}/metrics`

/** The queue's name, the overlay's actions, View metrics, and the badges under them. */
export function QueuePageHeader ({ data, extensions }: { data: QueuePageData, extensions?: QueuePageExtensions }) {
  const { queue, isDeadLetter, subscribedEvents } = data
  return (
    <>
      <PageHeader
        title={queue.name}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {extensions?.actions}
            <ProSlot name="queueActions" queue={{ name: queue.name, isDeadLetter }} />
            <Button
              variant="outline"
              size="md"
              render={<DbLink to={metricsPath(queue.name)} />}
            >
              <LineChart className="h-4 w-4 mr-1.5" aria-hidden="true" />
              View metrics
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 -mt-2">
        <Badge variant="primary">{queue.policy} policy</Badge>
        <Badge variant="gray">{queue.partition ? 'Partitioned' : 'Shared'} storage</Badge>
        {queue.deadLetter && <Badge variant="gray">dead letter → {queue.deadLetter}</Badge>}
        {subscribedEvents > 0 && (
          <DbLink to={`/subscriptions?queue=${encodeURIComponent(queue.name)}`}>
            <Badge variant="gray">
              subscribed to {subscribedEvents.toLocaleString()} {subscribedEvents === 1 ? 'event' : 'events'}
            </Badge>
          </DbLink>
        )}
      </div>
    </>
  )
}

/** The six counts, each opening the metrics page on its series, and the banner when no history is kept. */
export function QueueCounts ({ queue, statsAvailable }: { queue: QueueResult, statsAvailable: boolean }) {
  // ready_history is stored newest-first; reverse to chronological (oldest → newest) for the chart.
  const readyTrend = queue.readyHistory ? [...queue.readyHistory].reverse() : []
  // Link a StatCard to the metrics page pre-filtered to that single series.
  const metricsHref = (series: string) => `${metricsPath(queue.name)}?series=${series}`
  const overThreshold =
    (queue.warningQueueSize ?? 0) > 0 && queue.queuedCount > (queue.warningQueueSize ?? 0)

  return (
    <>
      {!statsAvailable && <StatsDisabledBanner />}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard
          label="Queued"
          value={queue.queuedCount.toLocaleString()}
          accent={overThreshold ? 'error' : 'neutral'}
          hint={overThreshold ? 'over threshold' : undefined}
          footer={queue.blockedCount > 0 ? `${queue.blockedCount.toLocaleString()} blocked by a flow parent` : undefined}
          to={metricsHref('queued')}
        />
        <StatCard label="Deferred" value={queue.deferredCount.toLocaleString()} to={metricsHref('deferred')} />
        <StatCard
          label="Ready"
          value={queue.readyCount.toLocaleString()}
          accent="primary"
          to={metricsHref('ready')}
          sparkline={readyTrend.length > 0 && (
            <Sparkline
              data={readyTrend}
              width={160}
              height={24}
              color="var(--primary-600)"
              aria-label="Ready count over the last hour"
            />
          )}
        />
        <StatCard label="Active" value={queue.activeCount.toLocaleString()} accent="primary" to={metricsHref('active')} />
        <StatCard label="Failed" value={queue.failedCount.toLocaleString()} to={metricsHref('failed')} />
        <StatCard label="Total" value={queue.totalCount.toLocaleString()} to={metricsHref('total')} />
      </div>
    </>
  )
}

/** The queue's settings, collapsed until opened. */
export function QueueConfig ({ queue }: { queue: QueueResult }) {
  const [configExpanded, setConfigExpanded] = useState(false)
  return (
      <Card>
        <button
          onClick={() => setConfigExpanded(!configExpanded)}
          className={cn(
            'w-full flex items-center justify-between px-5 py-4',
            'text-left hover:bg-[var(--surface-hover)]',
            'transition-colors cursor-pointer'
          )}
        >
          <h3 className="text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            Configuration
          </h3>
          {configExpanded ? (
            <ChevronDown className="h-5 w-5 text-[var(--text-tertiary)]" />
          ) : (
            <ChevronRight className="h-5 w-5 text-[var(--text-tertiary)]" />
          )}
        </button>

        {configExpanded && (
          <CardContent className="border-t border-[var(--border-subtle)]">
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                <ConfigItem label="Policy" value={queue.policy || '—'} />
                <ConfigItem label="Storage" value={queue.partition ? 'Partitioned' : 'Shared'} />
                <div>
                  <dt className="pgb-eyebrow">Dead Letter</dt>
                  <dd className="mt-1 text-sm text-[var(--text-primary)]">
                    {queue.deadLetter ? (
                      <DbLink
                        to={`/queues/${queue.deadLetter}`}
                        className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                      >
                        {queue.deadLetter}
                      </DbLink>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <ConfigItem label="Warning Threshold" value={queue.warningQueueSize || '—'} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                <ConfigItem label="Retry Limit" value={queue.retryLimit ?? 0} />
                <ConfigItem label="Retry Delay" value={queue.retryDelay ? `${queue.retryDelay}ms` : '—'} />
                <ConfigItem label="Retry Delay Max" value={queue.retryDelayMax ? `${queue.retryDelayMax}ms` : '—'} />
                <ConfigItem label="Retry Backoff" value={queue.retryBackoff ? 'Enabled' : 'Disabled'} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                <ConfigItem label="Expiration" value={formatDuration(queue.expireInSeconds)} />
                <ConfigItem label="Retention" value={formatDuration(queue.retentionSeconds)} />
                <ConfigItem label="Deletion" value={formatDuration(queue.deleteAfterSeconds)} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                <ConfigItem
                  label="Created"
                  value={queue.createdOn ? formatDate(new Date(queue.createdOn)) : '—'}
                />
                <ConfigItem
                  label="Last monitored"
                  value={queue.monitorOn ? formatDate(new Date(queue.monitorOn)) : '—'}
                />
                <ConfigItem
                  label="Last maintained"
                  value={queue.maintainOn ? formatDate(new Date(queue.maintainOn)) : '—'}
                />
              </div>
            </div>
          </CardContent>
        )}
      </Card>
  )
}

/** One page of the queue's jobs, filtered by state, with the viewer's columns. */
export function QueueJobs ({ data }: { data: QueuePageData }) {
  // Only an overlay acts on jobs; without one there is nothing to put in the column.
  const withActions = hasProSlot('jobRowActions')
  const { queue, jobs, totalCount, page, stateFilter, jobColumns, hasNextPage, hasPrevPage } = data
  const [searchParams, setSearchParams] = useSearchParams()

  const handleFilterChange = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (value) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    params.delete('page')
    setSearchParams(params)
  }

  const handleColumnsChange = (columns: JobColumn[]) => {
    const params = new URLSearchParams(searchParams)
    appendJobColumns(params, columns, DEFAULT_QUEUE_JOB_COLUMNS)
    params.delete('page')
    setSearchParams(params)
  }

  const getShareUrl = (columns: JobColumn[]) => {
    const params = new URLSearchParams(searchParams)
    appendJobColumns(params, columns, DEFAULT_QUEUE_JOB_COLUMNS)
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`
  }

  return (
      <Card>
        <CardHeader className="flex-col items-stretch sm:flex-row sm:items-center">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>
              Jobs
              {totalCount !== null && ` (${totalCount.toLocaleString()})`}
            </CardTitle>
            <FilterSelect
              value={stateFilter}
              options={JOB_STATE_OPTIONS}
              onChange={(value) => handleFilterChange('state', value)}
            />
          </div>
          <JobColumnsEditor
            columns={jobColumns}
            defaultColumns={DEFAULT_QUEUE_JOB_COLUMNS}
            getShareUrl={getShareUrl}
            onColumnsChange={handleColumnsChange}
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {jobColumns.map((col, index) => (
                  <TableHead key={`${col.path}-${index}`}>{col.name}</TableHead>
                ))}
                {withActions && <TableHead>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={jobColumns.length + (withActions ? 1 : 0)}>
                    No jobs found
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job: JobResult) => (
                  <JobRow key={job.id} job={job} queueName={queue.name} jobColumns={jobColumns} withActions={withActions} />
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <TablePagination
          page={page}
          totalPages={null}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
        />
      </Card>
  )
}

/**
 * The free page whole: header, counts, configuration and jobs. An overlay that replaces the page
 * composes it with its own `extensions`.
 */
export function QueuePage ({ data, extensions }: { data: QueuePageData, extensions?: QueuePageExtensions }) {
  return (
    <div className="space-y-4">
      <QueuePageHeader data={data} extensions={extensions} />
      {extensions?.afterHeader}
      <QueueCounts queue={data.queue} statsAvailable={data.statsAvailable} />
      <QueueConfig queue={data.queue} />
      <QueueJobs data={data} />
      {extensions?.below}
    </div>
  )
}

function JobRow ({
  job,
  queueName,
  jobColumns,
  withActions,
}: {
  job: JobResult
  queueName: string
  jobColumns: JobColumn[]
  withActions: boolean
}) {
  return (
    <TableRow to={`/queues/${encodeURIComponent(queueName)}/jobs/${job.id}`}>
      {jobColumns.map((column, index) => (
        <JobColumnCell
          key={`${column.path}-${index}`}
          row={job}
          column={column}
          queueName={queueName}
        />
      ))}
      {withActions && (
        <TableCell>
          <ProSlot name="jobRowActions" job={{ id: job.id, name: queueName, state: job.state }} />
        </TableCell>
      )}
    </TableRow>
  )
}

function ConfigItem ({
  label,
  value,
}: {
  label: string
  value: string | number | boolean | null
}) {
  return (
    <div>
      <dt className="pgb-eyebrow">{label}</dt>
      <dd className="mt-1 text-sm text-[var(--text-primary)]">
        {value?.toString() || '—'}
      </dd>
    </div>
  )
}

function formatDuration (seconds: number | null | undefined): string {
  if (!seconds) return '—'

  if (seconds < 60) {
    return `${seconds} seconds`
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600)
    const remainingMinutes = Math.floor((seconds % 3600) / 60)

    if (remainingMinutes === 0) {
      return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
    }

    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ${remainingMinutes} ${remainingMinutes === 1 ? 'minute' : 'minutes'}`
  }

  const days = Math.floor(seconds / 86400)
  const remainingHours = Math.floor((seconds % 86400) / 3600)

  if (remainingHours === 0) {
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }

  return `${days} ${days === 1 ? 'day' : 'days'} ${remainingHours} ${remainingHours === 1 ? 'hour' : 'hours'}`
}
