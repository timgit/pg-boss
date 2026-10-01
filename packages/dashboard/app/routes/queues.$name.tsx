import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { ChevronDown, ChevronRight, LineChart } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import type { Route } from './+types/queues.$name'
import {
  getQueue,
  getJobs,
  getJobCountFromQueue,
  getQueueStatsCollectionStatus,
  isDeadLetterQueue,
} from '~/lib/queries.server'
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
import { pageWindow, pageInfo } from '~/lib/pagination'
import { FilterSelect } from '~/components/ui/filter-select'
import { ErrorCard } from '~/components/error-card'
import { JobColumnsEditor } from '~/components/job-columns-editor'
import { JobColumnCell } from '~/components/job-column-cell'
import type { JobResult } from '~/lib/types'
import {
  isValidJobState,
  formatDate,
  JOB_STATE_OPTIONS,
  DEFAULT_STATE_FILTER,
  cn,
} from '~/lib/utils'
import { dbContext } from '~/lib/db-context'
import {
  DEFAULT_QUEUE_JOB_COLUMNS,
  parseJobColumns,
  appendJobColumns,
  type JobColumn,
} from '~/lib/job-columns'

const PAGE_SIZE = 50

export async function loader ({ params, request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const stateParam = url.searchParams.get('state')
  const jobColumns = parseJobColumns(url.searchParams, DEFAULT_QUEUE_JOB_COLUMNS)

  // Default to 'pending' filter to avoid showing completed/failed jobs in large queues
  // Users can explicitly select 'all' to see all jobs
  const stateFilter = stateParam !== null && isValidJobState(stateParam)
    ? stateParam
    : DEFAULT_STATE_FILTER

  const { page, limit, offset } = pageWindow(url, PAGE_SIZE)

  const queue = await getQueue(DB_URL, SCHEMA, params.name)

  if (!queue) {
    throw new Response('Queue not found', { status: 404 })
  }

  // The Ready sparkline comes from the always-on queue.ready_history column (loaded with `queue`).
  // collection drives the banner that points at the interactive metrics chart (needs persistQueueStats).
  const [jobs, collection, isDeadLetter] = await Promise.all([
    getJobs(DB_URL, SCHEMA, params.name, { state: stateFilter, limit, offset, jobColumns }),
    getQueueStatsCollectionStatus(DB_URL, SCHEMA),
    isDeadLetterQueue(DB_URL, SCHEMA, params.name),
  ])

  // Use cached count from queue table instead of COUNT(*) query
  // Returns null if count not available for this filter
  const totalCount = getJobCountFromQueue(queue, stateFilter)

  // The cached count lags the table, so it never decides which pages exist; a full page means
  // there may be another.
  const { hasNextPage, hasPrevPage } = pageInfo(page, PAGE_SIZE, jobs.length, null)

  return {
    queue,
    jobs,
    totalCount,
    page,
    stateFilter,
    jobColumns,
    hasNextPage,
    hasPrevPage,
    statsAvailable: collection.available,
    isDeadLetter,
  }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return (
    <ErrorCard
      title="Failed to load queue"
      error={error}
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function QueueDetail ({ loaderData }: Route.ComponentProps) {
  // Only an overlay acts on jobs; without one there is nothing to put in the column.
  const withActions = hasProSlot('jobRowActions')
  const {
    queue,
    jobs,
    totalCount,
    page,
    stateFilter,
    jobColumns,
    hasNextPage,
    hasPrevPage,
    statsAvailable,
    isDeadLetter,
  } = loaderData

  // ready_history is stored newest-first; reverse to chronological (oldest → newest) for the chart.
  const readyTrend = queue.readyHistory ? [...queue.readyHistory].reverse() : []

  // Link a StatCard to the queue's stats page, its depth panel showing that single series.
  const metricsHref = (series: string) =>
    `/stats/${encodeURIComponent(queue.name)}?series=${series}`
  const [searchParams, setSearchParams] = useSearchParams()
  const [configExpanded, setConfigExpanded] = useState(false)

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

  const overThreshold =
    (queue.warningQueueSize ?? 0) > 0 && queue.queuedCount > (queue.warningQueueSize ?? 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title={queue.name}
        action={
          <div className="flex items-center gap-2">
            <ProSlot name="queueActions" queue={{ name: queue.name, isDeadLetter }} />
            <Button
              variant="outline"
              size="md"
              render={<DbLink to={`/stats/${encodeURIComponent(queue.name)}`} />}
            >
              <LineChart className="h-4 w-4 mr-1.5" aria-hidden="true" />
              View stats
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 -mt-2">
        <Badge variant="primary">{queue.policy} policy</Badge>
        <Badge variant="gray">{queue.partition ? 'Partitioned' : 'Shared'} storage</Badge>
        {queue.deadLetter && <Badge variant="gray">dead letter → {queue.deadLetter}</Badge>}
      </div>

      {!statsAvailable && <StatsDisabledBanner />}

      {/* Queue Stats — each card opens the stats page with its depth panel on that series. */}
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
              aria-label="Ready count over the last 24 hours"
            />
          )}
        />
        <StatCard label="Active" value={queue.activeCount.toLocaleString()} accent="primary" to={metricsHref('active')} />
        <StatCard label="Failed" value={queue.failedCount.toLocaleString()} to={metricsHref('failed')} />
        <StatCard label="Total" value={queue.totalCount.toLocaleString()} to={metricsHref('total')} />
      </div>

      {/* Configuration Panel */}
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

      {/* Jobs Table */}
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
