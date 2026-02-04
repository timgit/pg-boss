import { useState } from 'react'
import { useFetcher } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.$name.jobs.$jobId'
import { getJob, cancelJob, retryJob, resumeJob, deleteJob, isValidIntent } from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { ErrorCard } from '~/components/error-card'
import { formatDate, JOB_STATE_VARIANTS, cn } from '~/lib/utils'

export async function loader ({ params, context }: Route.LoaderArgs) {
  const job = await getJob(context.DB_URL, context.SCHEMA, params.name, params.jobId)

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
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <DbLink to="/queues" className="hover:text-gray-700 dark:hover:text-gray-300">
          Queues
        </DbLink>
        <span>/</span>
        <DbLink to={`/queues/${queueName}`} className="hover:text-gray-700 dark:hover:text-gray-300">
          {queueName}
        </DbLink>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100 font-medium font-mono text-xs">
          {job.id.slice(0, 8)}...
        </span>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Job Details</h1>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant={JOB_STATE_VARIANTS[job.state]} size="sm">
              {job.state}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showError && (
            <span className="text-xs text-warning-600 dark:text-warning-400" title={actionResult.message}>
              Action failed
            </span>
          )}
          {(job.state === 'created' || job.state === 'retry' || job.state === 'active') && (
            <ConfirmDialog
              title="Cancel Job"
              description={`Are you sure you want to cancel job ${job.id.slice(0, 8)}...? This will stop the job from being processed.`}
              confirmLabel="Cancel Job"
              confirmVariant="danger"
              trigger="Cancel"
              onConfirm={() => submitAction('cancel')}
              isDisabled={isLoading}
            />
          )}
          {job.state === 'failed' && (
            <Button variant="ghost" size="sm" disabled={isLoading} onClick={() => submitAction('retry')}>
              Retry
            </Button>
          )}
          {job.state === 'cancelled' && (
            <Button variant="ghost" size="sm" disabled={isLoading} onClick={() => submitAction('resume')}>
              Resume
            </Button>
          )}
          {job.state !== 'active' && (
            <ConfirmDialog
              title="Delete Job"
              description={`Are you sure you want to delete job ${job.id.slice(0, 8)}...? This action cannot be undone.`}
              confirmLabel="Delete"
              confirmVariant="danger"
              trigger="Delete"
              onConfirm={() => submitAction('delete')}
              isDisabled={isLoading}
            />
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Job ID */}
          <div>
            <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
              Job ID
            </label>
            <div className="flex items-center gap-2">
              <code className={cn(
                'flex-1 text-sm px-3 py-2 rounded border font-mono break-all',
                'bg-gray-50 border-gray-200',
                'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
              )}>
                {job.id}
              </code>
              <Button variant="outline" size="sm" onClick={copyId}>
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>

          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                Priority
              </label>
              <p className="text-sm text-gray-900 dark:text-gray-100">{job.priority}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                Retries
              </label>
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {job.retryCount} / {job.retryLimit}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                Created
              </label>
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {formatDate(new Date(job.createdOn))}
              </p>
            </div>
            {job.startedOn && (
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Started
                </label>
                <p className="text-sm text-gray-900 dark:text-gray-100">
                  {formatDate(new Date(job.startedOn))}
                </p>
              </div>
            )}
            {job.completedOn && (
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Completed
                </label>
                <p className="text-sm text-gray-900 dark:text-gray-100">
                  {formatDate(new Date(job.completedOn))}
                </p>
              </div>
            )}
            {job.singletonKey && (
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Singleton Key
                </label>
                <p className="text-sm text-gray-900 dark:text-gray-100 font-mono">{job.singletonKey}</p>
              </div>
            )}
            {job.groupId && (
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Group ID
                </label>
                <p className="text-sm text-gray-900 dark:text-gray-100 font-mono">{job.groupId}</p>
              </div>
            )}
            {job.groupTier && (
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Group Tier
                </label>
                <p className="text-sm text-gray-900 dark:text-gray-100">{job.groupTier}</p>
              </div>
            )}
          </div>

          {/* Job Data (Payload) */}
          <div>
            <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
              Data (Payload)
            </label>
            <pre className={cn(
              'text-sm px-3 py-2 rounded border font-mono overflow-x-auto max-h-48',
              'bg-gray-50 border-gray-200',
              'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
            )}>
              {job.data ? JSON.stringify(job.data, null, 2) : 'null'}
            </pre>
          </div>

          {/* Job Output */}
          {job.output !== undefined && job.output !== null && (
            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                Output
              </label>
              <pre className={cn(
                'text-sm px-3 py-2 rounded border font-mono overflow-x-auto max-h-48',
                'bg-gray-50 border-gray-200',
                'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
              )}>
                {JSON.stringify(job.output, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
