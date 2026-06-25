import { useState } from 'react'
import { useFetcher, redirect } from 'react-router'
import { Copy, Check } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.$name.jobs.$jobId'
import { getJobById, cancelJob, retryJob, resumeJob, deleteJob, isValidIntent } from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { ErrorCard } from '~/components/error-card'
import { formatDate, JOB_STATE_VARIANTS, cn } from '~/lib/utils'

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const job = await getJobById(DB_URL, SCHEMA, params.name, params.jobId)

  if (!job) {
    throw new Response('Job not found', { status: 404 })
  }

  return { job, queueName: params.name }
}

export async function action ({ params, request, context }: Route.ActionArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const formData = await request.formData()
  const intent = formData.get('intent')
  const jobId = params.jobId

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

        // Redirect to queue jobs list after successful delete
        if (affected > 0) {
          const url = new URL(request.url)
          const dbParam = url.searchParams.get('db')
          const redirectUrl = dbParam
            ? `/queues/${params.name}?db=${encodeURIComponent(dbParam)}`
            : `/queues/${params.name}`
          return redirect(redirectUrl)
        }
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
      title="Failed to load job"
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function JobDetail ({ loaderData }: Route.ComponentProps) {
  const { job, queueName } = loaderData
  const fetcher = useFetcher<{ success?: boolean; affected?: number; message?: string; error?: string }>()
  const isLoading = fetcher.state !== 'idle'
  const [copied, setCopied] = useState(false)

  const actionResult = fetcher.data
  const showError = actionResult && !actionResult.success && actionResult.affected === 0

  const submitAction = (intent: string) => {
    fetcher.submit({ intent }, { method: 'post' })
  }

  const copyId = async () => {
    await navigator.clipboard.writeText(job.id)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isFailed = job.state === 'failed'

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            Job detail
            <Badge variant={JOB_STATE_VARIANTS[job.state]} size="lg" dot>{job.state}</Badge>
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            {showError && (
              <span className="text-xs text-[var(--warning-600)]" title={actionResult.message}>
                Action failed
              </span>
            )}
            {job.state === 'failed' && (
              <Button variant="outline" size="sm" disabled={isLoading} onClick={() => submitAction('retry')}>
                Retry
              </Button>
            )}
            {job.state === 'cancelled' && (
              <Button variant="outline" size="sm" disabled={isLoading} onClick={() => submitAction('resume')}>
                Resume
              </Button>
            )}
            {(job.state === 'created' || job.state === 'retry' || job.state === 'active') && (
              <ConfirmDialog
                title="Cancel Job"
                description={`Are you sure you want to cancel job ${job.id.slice(0, 8)}...? This will prevent the job from being processed.`}
                confirmLabel="Cancel Job"
                confirmVariant="danger"
                triggerVariant="outline"
                trigger="Cancel"
                onConfirm={() => submitAction('cancel')}
                disabled={isLoading}
              />
            )}
            {job.state !== 'active' && (
              <ConfirmDialog
                title="Delete Job"
                description={`Are you sure you want to delete job ${job.id.slice(0, 8)}...? This action cannot be undone.`}
                confirmLabel="Delete"
                confirmVariant="danger"
                triggerVariant="danger"
                trigger="Delete"
                onConfirm={() => submitAction('delete')}
                disabled={isLoading}
              />
            )}
          </div>
        }
      />

      {/* Details Card */}
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <span className="text-xs text-[var(--text-tertiary)]">
            in queue{' '}
            <DbLink
              to={`/queues/${encodeURIComponent(queueName)}`}
              className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              {queueName}
            </DbLink>
          </span>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Job ID, policy, priority */}
          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr] gap-6">
            <div>
              <div className="pgb-eyebrow mb-1">Job ID</div>
              <div className="flex items-center gap-1.5">
                <code className="text-sm font-mono break-all text-[var(--text-primary)]">
                  {job.id}
                </code>
                <button
                  onClick={copyId}
                  className={cn(
                    'p-1 rounded-md transition-colors cursor-pointer flex-shrink-0',
                    'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                  )}
                  title={copied ? 'Copied!' : 'Copy to clipboard'}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-[var(--success-600)]" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <ConfigItem label="Policy" value={job.policy || '—'} />
            <ConfigItem label="Priority" value={job.priority} mono />
          </div>

          {/* Data and Output */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="pgb-eyebrow mb-1.5">Data</div>
              <pre className="text-xs px-3.5 py-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-sunken)] font-mono leading-relaxed text-[var(--text-primary)] overflow-auto max-h-40">
                {job.data ? JSON.stringify(job.data, null, 2) : 'null'}
              </pre>
            </div>

            <div>
              <div className="pgb-eyebrow mb-1.5">Output</div>
              <pre
                className={cn(
                  'text-xs px-3.5 py-3 rounded-lg border font-mono leading-relaxed text-[var(--text-primary)] overflow-auto max-h-40',
                  isFailed
                    ? 'border-[var(--error-100)] bg-[var(--error-50)]'
                    : 'border-[var(--border-default)] bg-[var(--surface-sunken)]'
                )}
              >
                {job.output !== undefined && job.output !== null ? JSON.stringify(job.output, null, 2) : '—'}
              </pre>
            </div>
          </div>

          {/* Configuration */}
          <div>
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                <ConfigItem label="Priority" value={job.priority} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                <ConfigItem label="Retry Count" value={job.retryCount} mono />
                <ConfigItem label="Retry Limit" value={job.retryLimit} mono />
                <ConfigItem label="Retry Delay" value={job.retryDelay ? `${job.retryDelay}ms` : '—'} mono />
                <ConfigItem label="Retry Backoff" value={job.retryBackoff ? 'Enabled' : 'Disabled'} />
              </div>

              {(job.singletonKey || job.groupId || job.groupTier || job.deadLetter) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                  {job.singletonKey && (
                    <ConfigItem label="Singleton Key" value={job.singletonKey} mono />
                  )}
                  {job.groupId && (
                    <ConfigItem label="Group ID" value={job.groupId} mono />
                  )}
                  {job.groupTier && (
                    <ConfigItem label="Group Tier" value={job.groupTier} mono />
                  )}
                  {job.deadLetter && (
                    <div>
                      <dt className="pgb-eyebrow">Dead Letter</dt>
                      <dd className="mt-1 text-sm text-[var(--text-primary)]">
                        <DbLink
                          to={`/queues/${job.deadLetter}`}
                          className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                        >
                          {job.deadLetter}
                        </DbLink>
                      </dd>
                    </div>
                  )}
                </div>
              )}

              {(job.sourceName || job.sourceId) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                  {job.sourceName && (
                    <div>
                      <dt className="pgb-eyebrow">Source Queue</dt>
                      <dd className="mt-1 text-sm text-[var(--text-primary)]">
                        <DbLink
                          to={`/queues/${job.sourceName}`}
                          className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                        >
                          {job.sourceName}
                        </DbLink>
                      </dd>
                    </div>
                  )}
                  {job.sourceId && (
                    <ConfigItem label="Source Job ID" value={job.sourceId} mono />
                  )}
                  {job.sourceRetryCount !== null && job.sourceRetryCount !== undefined && (
                    <ConfigItem label="Source Retry Count" value={job.sourceRetryCount} mono />
                  )}
                  {job.sourceCreatedOn && (
                    <ConfigItem label="Source Created" value={formatDate(new Date(job.sourceCreatedOn))} mono />
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-6 gap-y-4">
                <ConfigItem
                  label="Created"
                  value={formatDate(new Date(job.createdOn))}
                  mono
                />
                <ConfigItem
                  label="Start After"
                  value={job.startAfter ? formatDate(new Date(job.startAfter)) : '—'}
                  mono
                />
                <ConfigItem
                  label="Started"
                  value={job.startedOn ? formatDate(new Date(job.startedOn)) : '—'}
                  mono
                />
                <ConfigItem
                  label="Completed"
                  value={job.completedOn ? formatDate(new Date(job.completedOn)) : '—'}
                  mono
                />
                <ConfigItem
                  label="Keep Until"
                  value={job.keepUntil ? formatDate(new Date(job.keepUntil)) : '—'}
                  mono
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ConfigItem ({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string | number | boolean | null
  mono?: boolean
}) {
  return (
    <div>
      <dt className="pgb-eyebrow">{label}</dt>
      <dd className={cn('mt-1 text-sm text-[var(--text-primary)]', mono && 'pgb-num')}>
        {value?.toString() || '—'}
      </dd>
    </div>
  )
}
