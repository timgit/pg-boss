import { useState } from 'react'
import { useFetcher, useSearchParams } from 'react-router'
import { MoreHorizontal, ChevronDown, ChevronRight } from 'lucide-react'
import { Menu } from '@base-ui/react/menu'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.$name'
import {
  getQueue,
  getJobs,
  getJobCountFromQueue,
  cancelJob,
  retryJob,
  resumeJob,
  deleteJob,
  isValidIntent,
} from '~/lib/queries.server'
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
import { Pagination } from '~/components/ui/pagination'
import { FilterSelect } from '~/components/ui/filter-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { ErrorCard } from '~/components/error-card'
import { JobColumnsEditor } from '~/components/job-columns-editor'
import { JobColumnCell } from '~/components/job-column-cell'
import type { JobResult } from '~/lib/types'
import {
  parsePageNumber,
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

  const page = parsePageNumber(url.searchParams.get('page'))
  const limit = 50
  const offset = (page - 1) * limit

  const queue = await getQueue(DB_URL, SCHEMA, params.name)

  if (!queue) {
    throw new Response('Queue not found', { status: 404 })
  }

  const jobs = await getJobs(DB_URL, SCHEMA, params.name, {
    state: stateFilter,
    limit,
    offset,
    jobColumns,
  })

  // Use cached count from queue table instead of COUNT(*) query
  // Returns null if count not available for this filter
  const totalCount = getJobCountFromQueue(queue, stateFilter)
  const totalPages = totalCount !== null ? Math.ceil(totalCount / limit) : null

  // Determine if there are more pages based on results
  const hasNextPage = jobs.length === limit
  const hasPrevPage = page > 1

  return {
    queue,
    jobs,
    totalCount,
    page,
    totalPages,
    stateFilter,
    jobColumns,
    hasNextPage,
    hasPrevPage,
  }
}

export async function action ({ params, request, context }: Route.ActionArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const formData = await request.formData()
  const intent = formData.get('intent')
  const jobId = formData.get('jobId') as string

  if (!jobId || typeof jobId !== 'string') {
    return { error: 'Job ID is required', affected: 0 }
  }

  if (!isValidIntent(intent)) {
    return { error: 'Invalid action', affected: 0 }
  }

  let affected = 0
  let message = ''

  try {
    switch (intent) {
      case 'cancel':
        affected = await cancelJob(DB_URL, SCHEMA, params.name, jobId)
        message = affected > 0
          ? 'Job cancelled'
          : 'Job could not be cancelled (may already be completed or cancelled)'
        break
      case 'retry':
        affected = await retryJob(DB_URL, SCHEMA, params.name, jobId)
        message = affected > 0
          ? 'Job queued for retry'
          : 'Job could not be retried (only failed jobs can be retried)'
        break
      case 'resume':
        affected = await resumeJob(DB_URL, SCHEMA, params.name, jobId)
        message = affected > 0
          ? 'Job resumed'
          : 'Job could not be resumed (only cancelled jobs can be resumed)'
        break
      case 'delete':
        affected = await deleteJob(DB_URL, SCHEMA, params.name, jobId)
        message = affected > 0
          ? 'Job deleted'
          : 'Job could not be deleted (may be active or already deleted)'
        break
    }
  } catch (err) {
    return { error: 'Database error occurred', affected: 0 }
  }

  return { success: affected > 0, affected, message }
}

export function ErrorBoundary () {
  return (
    <ErrorCard
      title="Failed to load queue"
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function QueueDetail ({ loaderData }: Route.ComponentProps) {
  const {
    queue,
    jobs,
    totalCount,
    page,
    totalPages,
    stateFilter,
    jobColumns,
    hasNextPage,
    hasPrevPage,
  } = loaderData
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

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams)
    params.set('page', newPage.toString())
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
        subtitle={`${queue.partition ? 'Partitioned' : 'Shared'} storage`}
        action={
          <DbLink to={`/send?queue=${encodeURIComponent(queue.name)}`}>
            <Button variant="primary" size="md">Send Job</Button>
          </DbLink>
        }
      />

      <div className="flex flex-wrap items-center gap-2 -mt-2">
        <Badge variant="primary">{queue.policy} policy</Badge>
        {queue.deadLetter && <Badge variant="gray">dead letter → {queue.deadLetter}</Badge>}
        {(queue.retryLimit ?? 0) > 0 && <Badge variant="gray">retry limit {queue.retryLimit}</Badge>}
      </div>

      {/* Queue Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard
          label="Queued"
          value={queue.queuedCount.toLocaleString()}
          accent={overThreshold ? 'error' : 'neutral'}
          hint={overThreshold ? 'over threshold' : 'incl. deferred'}
        />
        <StatCard label="Deferred" value={queue.deferredCount.toLocaleString()} />
        <StatCard label="Ready" value={queue.readyCount.toLocaleString()} accent="primary" hint="ready to process" />
        <StatCard label="Active" value={queue.activeCount.toLocaleString()} accent="primary" />
        <StatCard label="Failed" value={queue.failedCount.toLocaleString()} hint="recent failures" />
        <StatCard label="Total" value={queue.totalCount.toLocaleString()} />
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
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={jobColumns.length + 1}>
                    No jobs found
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job: JobResult) => (
                  <JobRow key={job.id} job={job} queueName={queue.name} jobColumns={jobColumns} />
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <Pagination
          page={page}
          totalPages={totalPages}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
          onPageChange={handlePageChange}
        />
      </Card>
    </div>
  )
}

function JobRow ({
  job,
  queueName,
  jobColumns,
}: {
  job: JobResult
  queueName: string
  jobColumns: JobColumn[]
}) {
  const fetcher = useFetcher<{ success?: boolean; affected?: number; message?: string; error?: string }>()
  const isLoading = fetcher.state !== 'idle'
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    intent: string
  } | null>(null)

  // Show feedback after action completes
  const actionResult = fetcher.data
  const showError = actionResult && !actionResult.success && actionResult.affected === 0

  const submitAction = (intent: string) => {
    fetcher.submit({ jobId: job.id, intent }, { method: 'post' })
  }

  const openConfirmDialog = (intent: string, title: string, description: string, confirmLabel: string) => {
    setConfirmDialog({ open: true, title, description, confirmLabel, intent })
  }

  const handleConfirm = () => {
    if (confirmDialog) {
      submitAction(confirmDialog.intent)
      setConfirmDialog(null)
    }
  }

  // Determine available actions based on job state
  const canCancel = job.state === 'created' || job.state === 'retry' || job.state === 'active'
  const canRetry = job.state === 'failed'
  const canResume = job.state === 'cancelled'
  const canDelete = job.state !== 'active'

  const menuItemClass = cn(
    'flex w-full items-center px-3 py-2 text-sm cursor-pointer',
    'outline-none transition-colors rounded-sm',
    'text-gray-700 data-highlighted:bg-gray-100 data-highlighted:text-gray-900',
    'dark:text-gray-300 dark:data-highlighted:bg-gray-800 dark:data-highlighted:text-gray-100'
  )

  const dangerMenuItemClass = cn(
    'flex w-full items-center px-3 py-2 text-sm cursor-pointer',
    'outline-none transition-colors rounded-sm',
    'text-red-600 data-highlighted:bg-red-50 data-highlighted:text-red-700',
    'dark:text-red-400 dark:data-highlighted:bg-red-950 dark:data-highlighted:text-red-300'
  )

  return (
    <>
      <TableRow>
        {jobColumns.map((column, index) => (
          <JobColumnCell
            key={`${column.path}-${index}`}
            row={job}
            column={column}
            queueName={queueName}
          />
        ))}
        <TableCell>
          <div className="flex items-center gap-2">
            {showError && (
              <span className="text-xs text-amber-600 dark:text-amber-400" title={actionResult.message}>
                Failed
              </span>
            )}
            <Menu.Root>
              <Menu.Trigger
                className={cn(
                  'inline-flex items-center justify-center rounded-md p-1.5',
                  'text-gray-500 hover:text-gray-900 hover:bg-gray-100',
                  'dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800',
                  'focus:outline-none focus:ring-2 focus:ring-primary-500',
                  'transition-colors disabled:opacity-50'
                )}
                disabled={isLoading}
                aria-label="Job actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner>
                  <Menu.Popup
                    className={cn(
                      'min-w-[10rem] rounded-md border p-1 shadow-md z-50',
                      'bg-white border-gray-200',
                      'dark:bg-gray-900 dark:border-gray-800',
                      'animate-in fade-in-0 zoom-in-95'
                    )}
                  >
                    {canRetry && (
                      <Menu.Item
                        className={menuItemClass}
                        onClick={() => submitAction('retry')}
                      >
                        Retry
                      </Menu.Item>
                    )}
                    {canResume && (
                      <Menu.Item
                        className={menuItemClass}
                        onClick={() => submitAction('resume')}
                      >
                        Resume
                      </Menu.Item>
                    )}
                    {canCancel && (
                      <Menu.Item
                        className={dangerMenuItemClass}
                        onClick={() => openConfirmDialog(
                          'cancel',
                          'Cancel Job',
                          `Are you sure you want to cancel job ${job.id.slice(0, 8)}...? This will stop the job from being processed.`,
                          'Cancel Job'
                        )}
                      >
                        Cancel
                      </Menu.Item>
                    )}
                    {canDelete && (
                      <Menu.Item
                        className={dangerMenuItemClass}
                        onClick={() => openConfirmDialog(
                          'delete',
                          'Delete Job',
                          `Are you sure you want to delete job ${job.id.slice(0, 8)}...? This action cannot be undone.`,
                          'Delete'
                        )}
                      >
                        Delete
                      </Menu.Item>
                    )}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </TableCell>
      </TableRow>

      {/* Confirmation Dialog */}
      <Dialog open={confirmDialog?.open ?? false} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <DialogContent hideCloseButton className="w-[28rem] max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{confirmDialog?.title}</DialogTitle>
            <DialogDescription className="mt-2">{confirmDialog?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6 flex justify-end gap-3">
            <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => setConfirmDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="cursor-pointer"
              onClick={handleConfirm}
            >
              {confirmDialog?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
