import { useState } from 'react'
import { useFetcher, redirect } from 'react-router'
import { Copy, Check } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.$name.jobs.$jobId'
import { getJobById, cancelJob, retryJob, resumeJob, deleteJob, isValidIntent } from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { ErrorCard } from '~/components/error-card'
import { formatDate, JOB_STATE_VARIANTS, cn } from '~/lib/utils'

export async function loader ({ params, context }: Route.LoaderArgs) {
  const job = await getJobById(context.DB_URL, context.SCHEMA, params.name, params.jobId)

  if (!job) {
    throw new Response('Job not found', { status: 404 })
  }

  return { job, queueName: params.name }
}

export async function action ({ params, request, context }: Route.ActionArgs) {
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
        affected = await cancelJob(context.DB_URL, context.SCHEMA, params.name, jobId)
        message = affected > 0
          ? 'Job cancelled'
          : 'Job could not be cancelled (may already be completed or cancelled)'
        break
      case 'retry':
        affected = await retryJob(context.DB_URL, context.SCHEMA, params.name, jobId)
        message = affected > 0
          ? 'Job queued for retry'
          : 'Job could not be retried (only failed jobs can be retried)'
        break
      case 'resume':
        affected = await resumeJob(context.DB_URL, context.SCHEMA, params.name, jobId)
        message = affected > 0
          ? 'Job resumed'
          : 'Job could not be resumed (only cancelled jobs can be resumed)'
        break
      case 'delete':
        affected = await deleteJob(context.DB_URL, context.SCHEMA, params.name, jobId)
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Job Details - {queueName}
        </h1>
      </div>

      {/* Details Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Details</CardTitle>
          <div className="flex items-center gap-2">
            {showError && (
              <span className="text-xs text-amber-600 dark:text-amber-400" title={actionResult.message}>
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
                isDisabled={isLoading}
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
                isDisabled={isLoading}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Queue */}
          <div>
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Queue</dt>
            <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <DbLink
                to={`/queues/${encodeURIComponent(queueName)}`}
                className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              >
                {queueName}
              </DbLink>
              {job.policy && (
                <Badge variant="gray" size="sm">
                  {job.policy}
                </Badge>
              )}
            </dd>
          </div>

          {/* Job ID and State */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                Job ID
              </label>
              <div className="flex items-center gap-1.5">
                <code className="text-sm font-mono break-all text-gray-900 dark:text-gray-100">
                  {job.id}
                </code>
                <button
                  onClick={copyId}
                  className={cn(
                    'p-1 rounded-md transition-colors cursor-pointer flex-shrink-0',
                    'text-gray-500 hover:text-gray-900 hover:bg-gray-100',
                    'dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800'
                  )}
                  title={copied ? 'Copied!' : 'Copy to clipboard'}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                State
              </label>
              <div className="text-sm text-gray-900 dark:text-gray-100">
                {job.state}
              </div>
            </div>
          </div>

          {/* Data and Output */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                Data
              </label>
              <pre className={cn(
                'text-sm px-3 py-2 rounded border font-mono overflow-auto max-h-32',
                'bg-gray-50 border-gray-200',
                'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
              )}>
                {job.data ? JSON.stringify(job.data, null, 2) : 'null'}
              </pre>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                Output
              </label>
              <pre className={cn(
                'text-sm px-3 py-2 rounded border font-mono overflow-auto max-h-32',
                'bg-gray-50 border-gray-200',
                'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
              )}>
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
                <ConfigItem label="Retry Count" value={job.retryCount} />
                <ConfigItem label="Retry Limit" value={job.retryLimit} />
                <ConfigItem label="Retry Delay" value={job.retryDelay ? `${job.retryDelay}ms` : '—'} />
                <ConfigItem label="Retry Backoff" value={job.retryBackoff ? 'Enabled' : 'Disabled'} />
              </div>

              {(job.singletonKey || job.groupId || job.groupTier || job.deadLetter) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
                  {job.singletonKey && (
                    <ConfigItem label="Singleton Key" value={job.singletonKey} />
                  )}
                  {job.groupId && (
                    <ConfigItem label="Group ID" value={job.groupId} />
                  )}
                  {job.groupTier && (
                    <ConfigItem label="Group Tier" value={job.groupTier} />
                  )}
                  {job.deadLetter && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Dead Letter</dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        <DbLink
                          to={`/queues/${job.deadLetter}`}
                          className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                        >
                          {job.deadLetter}
                        </DbLink>
                      </dd>
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-6 gap-y-4">
                <ConfigItem
                  label="Created"
                  value={formatDate(new Date(job.createdOn))}
                />
                <ConfigItem
                  label="Start After"
                  value={job.startAfter ? formatDate(new Date(job.startAfter)) : '—'}
                />
                <ConfigItem
                  label="Started"
                  value={job.startedOn ? formatDate(new Date(job.startedOn)) : '—'}
                />
                <ConfigItem
                  label="Completed"
                  value={job.completedOn ? formatDate(new Date(job.completedOn)) : '—'}
                />
                <ConfigItem
                  label="Keep Until"
                  value={job.keepUntil ? formatDate(new Date(job.keepUntil)) : '—'}
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
}: {
  label: string
  value: string | number | boolean | null
}) {
  return (
    <div>
      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
        {value?.toString() || '—'}
      </dd>
    </div>
  )
}
