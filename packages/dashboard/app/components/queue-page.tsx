import { type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { LineChart } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import { DeadLetterBadge } from '~/components/dead-letter-badge'
import { PolicyBadge } from '~/components/policy-badge'
import { ConfigCard, type ConfigRow } from '~/components/job-detail'
import { CountsCard, strong } from '~/components/stats-cards'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import { Sparkline } from '~/components/ui/sparkline'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
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
import { formatDate, JOB_STATE_OPTIONS, jobListSortColumn, resetPaging } from '~/lib/utils'
import { formatSeconds } from '~/lib/job-detail'
import {
  DEFAULT_QUEUE_JOB_COLUMNS,
  defaultJobColumnsFor,
  appendJobColumns,
  type JobColumn,
} from '~/lib/job-columns'
import type { QueuePageData } from '~/lib/queue-page.server'
import { Count } from '~/components/ui/count'

/**
 * What an overlay that replaces a queue's page adds to the sections it composes. Every field is
 * optional, and without them the page is the free one.
 */
export interface QueuePageExtensions {
  /** In the header, on its own line under the queue actions and View metrics, such as a range switch. */
  toolbar?: ReactNode
  /** Between the header and the counts. */
  afterHeader?: ReactNode
  /** At the end of the page, under the jobs. */
  below?: ReactNode
}

const metricsPath = (name: string) => `/queues/${encodeURIComponent(name)}/metrics`

/** The queue's name, with a badge when other queues send it their failed jobs, the overlay's actions and View metrics. */
export function QueuePageHeader ({ data, extensions }: { data: QueuePageData, extensions?: QueuePageExtensions }) {
  const { queue, isDeadLetter } = data
  return (
    <PageHeader
      parent={{ to: '/queues', label: 'Queues' }}
      title={`Queue: ${queue.name}`}
      badge={isDeadLetter ? <DeadLetterBadge /> : undefined}
      action={
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
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
          {extensions?.toolbar}
        </div>
      }
    />
  )
}

/**
 * Ready, active, failed and total in one card, as on the overview, each opening the metrics page at
 * the chart that holds it. An overlay that knows the queue's workers gives Active its own lines.
 */
export function QueueCounts ({ queue, activeLines = ['processing now'] }: { queue: QueueResult, activeLines?: ReactNode[] }) {
  // ready_history is stored newest-first; reverse to chronological (oldest → newest) for the chart.
  const readyTrend = queue.readyHistory ? [...queue.readyHistory].reverse() : []
  const waitingHref = `${metricsPath(queue.name)}#waiting`
  const activeHref = `${metricsPath(queue.name)}#active`
  const warningSize = queue.warningQueueSize ?? 0
  const overWarning = warningSize > 0 && queue.queuedCount > warningSize
  // Total counts the completed and canceled jobs still kept as well as the live ones.
  const finished = Math.max(0, queue.totalCount - queue.queuedCount - queue.activeCount - queue.failedCount)

  return (
    <CountsCard
      label="Counts"
      cells={[
        {
          key: 'ready',
          label: 'Ready',
          value: queue.readyCount,
          primary: true,
          to: waitingHref,
          aside: readyTrend.length > 0 && (
            <Sparkline
              data={readyTrend}
              width={96}
              height={26}
              color="var(--primary-600)"
              area
              aria-label="Ready count over the last hour"
            />
          ),
          lines: [
            overWarning
              ? <>of {strong(queue.queuedCount, 'text-[var(--state-failed-fg)]')} queued, over its warning size of <Count value={warningSize} /></>
              : <>of {strong(queue.queuedCount)} queued</>,
            <>{queue.deferredCount > 0 ? <><Count value={queue.deferredCount} /> deferred for later</> : 'none deferred'}{queue.blockedCount > 0 && <> · <Count value={queue.blockedCount} /> blocked</>}</>,
          ],
        },
        { key: 'active', label: 'Active', value: queue.activeCount, primary: true, to: activeHref, lines: activeLines },
        { key: 'failed', label: 'Failed', value: queue.failedCount, to: activeHref, lines: ['recent failures'] },
        {
          key: 'total',
          label: 'Total Jobs',
          value: queue.totalCount,
          to: `${metricsPath(queue.name)}?total=1#active`,
          lines: ['stored in this queue', ...(finished > 0 ? [<><Count value={finished} /> completed or canceled</>] : [])],
        },
      ]}
    />
  )
}

/** How a queue retries: how many times, after how long, and whether the wait grows. */
function retries (queue: QueueResult): string {
  const delay = queue.retryDelay ? `every ${formatSeconds(queue.retryDelay)}` : 'right away'
  const backoff = queue.retryBackoff ? `, backing off${queue.retryDelayMax ? ` to ${formatSeconds(queue.retryDelayMax)}` : ''}` : ''
  return `${queue.retryLimit}, ${delay}${backoff}`
}

/** The queue's settings, only those it has, and the events it is subscribed to. */
export function QueueConfig ({ queue, subscribedEvents = 0 }: { queue: QueueResult, subscribedEvents?: number }) {
  const rows: ConfigRow[] = [
    { label: 'Policy', value: <PolicyBadge policy={queue.policy} /> },
    { label: 'Storage', value: queue.partition ? 'Partitioned' : 'Shared' },
  ]
  if (queue.deadLetter) {
    rows.push({
      label: 'Dead letter queue',
      mono: true,
      value: (
        <DbLink to={`/queues/${encodeURIComponent(queue.deadLetter)}`} className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300">
          {queue.deadLetter}
        </DbLink>
      ),
    })
  }
  if (queue.warningQueueSize) rows.push({ label: 'Warning size', value: `${queue.warningQueueSize.toLocaleString()} queued` })
  if (queue.retryLimit) rows.push({ label: 'Retries', value: retries(queue) })
  if (queue.expireInSeconds) rows.push({ label: 'Expiration', value: formatSeconds(queue.expireInSeconds) })
  if (queue.retentionSeconds) rows.push({ label: 'Queued jobs kept', value: formatSeconds(queue.retentionSeconds) })
  if (queue.deleteAfterSeconds) rows.push({ label: 'Completed jobs kept', value: formatSeconds(queue.deleteAfterSeconds) })
  if (subscribedEvents > 0) {
    rows.push({
      label: 'Subscribed to',
      value: (
        <DbLink to={`/subscriptions?queue=${encodeURIComponent(queue.name)}`} className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300">
          {subscribedEvents.toLocaleString()} {subscribedEvents === 1 ? 'event' : 'events'}
        </DbLink>
      ),
    })
  }
  return <ConfigCard rows={rows} unset={[]} />
}

/** When the queue was made, and when pg-boss last counted and maintained it. */
export function QueueUpkeep ({ queue }: { queue: QueueResult }) {
  const when = (date: Date | string | null | undefined) => (date ? formatDate(new Date(date)) : '—')
  return (
    <ConfigCard
      title="Upkeep"
      rows={[
        { label: 'Created', value: when(queue.createdOn) },
        { label: 'Last monitored', value: when(queue.monitorOn) },
        { label: 'Last maintained', value: when(queue.maintainOn) },
      ]}
      unset={[]}
    />
  )
}

/** One page of the queue's jobs, filtered by state, with the viewer's columns. */
export function QueueJobs ({ data }: { data: QueuePageData }) {
  // Only an overlay acts on jobs; without one there is nothing to put in the column.
  const withActions = hasProSlot('jobRowActions')
  const { queue, jobs, totalCount, page, stateFilter, jobColumns, hasNextPage, hasPrevPage, nextCursor, prevCursor } = data
  const [searchParams, setSearchParams] = useSearchParams()

  const handleFilterChange = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (value) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    resetPaging(params)
    setSearchParams(params)
  }

  // Default columns are left out of the URL, so they follow the state filter's defaults.
  const defaultColumns = defaultJobColumnsFor(stateFilter, DEFAULT_QUEUE_JOB_COLUMNS)

  const handleColumnsChange = (columns: JobColumn[]) => {
    const params = new URLSearchParams(searchParams)
    appendJobColumns(params, columns, defaultColumns)
    resetPaging(params)
    setSearchParams(params)
  }

  const getShareUrl = (columns: JobColumn[]) => {
    const params = new URLSearchParams(searchParams)
    appendJobColumns(params, columns, defaultColumns)
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
            defaultColumns={defaultColumns}
            getShareUrl={getShareUrl}
            onColumnsChange={handleColumnsChange}
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {jobColumns.map((col, index) => (
                  <TableHead key={`${col.path}-${index}`} sortedDesc={col.path === jobListSortColumn(stateFilter)}>{col.name}</TableHead>
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
          nextCursor={nextCursor}
          prevCursor={prevCursor}
          totalPages={null}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
        />
      </Card>
  )
}

/**
 * The free page whole: header, then the counts and jobs beside the queue's settings, as a job's page
 * sets its details beside its data. An overlay that replaces the page composes it with its own
 * `extensions`.
 */
export function QueuePage ({ data, extensions }: { data: QueuePageData, extensions?: QueuePageExtensions }) {
  return (
    <div>
      <QueuePageHeader data={data} extensions={extensions} />
      {extensions?.afterHeader && <div className="mb-6">{extensions.afterHeader}</div>}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          {!data.statsAvailable && <StatsDisabledBanner />}
          <QueueCounts queue={data.queue} />
          <QueueJobs data={data} />
        </div>
        <aside className="flex flex-col gap-6" aria-label="Queue settings">
          <QueueConfig queue={data.queue} subscribedEvents={data.subscribedEvents} />
          <QueueUpkeep queue={data.queue} />
        </aside>
      </div>
      {extensions?.below && <div className="mt-6">{extensions.below}</div>}
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
