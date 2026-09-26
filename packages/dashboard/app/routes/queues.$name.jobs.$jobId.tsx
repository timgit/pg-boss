import { useEffect, useRef } from 'react'
import { useFetcher, useRevalidator, redirect } from 'react-router'
import { Inbox, Play, RotateCcw, Trash2, Ban } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.$name.jobs.$jobId'
import { useCan } from '~/lib/use-capabilities'
import {
  getJobById,
  getJobPageContext,
  getLinkedJob,
  cancelJob,
  retryJob,
  resumeJob,
  deleteJob,
  isValidIntent,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { ErrorCard } from '~/components/error-card'
import {
  ConfigCard,
  CopyButton,
  DeadLetterPanel,
  FailurePanel,
  LineageCard,
  PayloadCard,
  RetriesCard,
  RunningPanel,
  StateBadge,
  TimelineCard,
  useLiveNow,
  type ConfigRow,
} from '~/components/job-detail'
import { attempts, formatDuration, formatSeconds, isFinalState, statusLine, toDate, type JobTimes } from '~/lib/job-detail'
import { formatDate } from '~/lib/utils'

// How often an unfinished job's page checks for a new state while it is open and visible.
const REFRESH_MS = 10_000

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const job = await getJobById(DB_URL, SCHEMA, params.name, params.jobId)

  if (!job) {
    throw new Response('Job not found', { status: 404 })
  }

  // The root's queue is not stored. Redrive sends a job back to its source queue unless told
  // otherwise, so that is where the root usually is: the source's queue for a dead-letter copy, this
  // job's own queue for a redriven one.
  const rootQueue = job.sourceName ?? params.name
  const hasRoot = !!job.sourceRootId && job.sourceRootId !== job.sourceId

  const [pageContext, source, root] = await Promise.all([
    getJobPageContext(DB_URL, SCHEMA, params.name),
    job.sourceId && job.sourceName ? getLinkedJob(DB_URL, SCHEMA, job.sourceName, job.sourceId) : null,
    hasRoot ? getLinkedJob(DB_URL, SCHEMA, rootQueue, job.sourceRootId!) : null,
  ])

  return {
    job,
    queueName: params.name,
    now: new Date(pageContext.now).toISOString(),
    isDeadLetterQueue: pageContext.isDeadLetterQueue,
    rootQueue,
    source,
    root,
  }
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

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return (
    <ErrorCard
      title="Failed to load job"
      error={error}
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

// Re-run the loader while the job can still change state, so a running job's page moves on to
// completed or failed without a reload. Paused while the tab is hidden, and caught up the moment it
// is shown again. The revalidator is read through a ref: the page re-renders every second while a
// counter ticks, and an effect keyed on it would restart the interval before it ever fired.
function useRefreshWhileUnfinished (unfinished: boolean) {
  const revalidator = useRevalidator()
  const latest = useRef(revalidator)
  latest.current = revalidator

  useEffect(() => {
    if (!unfinished) return
    const refresh = () => {
      if (document.visibilityState === 'visible' && latest.current.state === 'idle') latest.current.revalidate()
    }
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [unfinished])
}

export default function JobDetail ({ loaderData }: Route.ComponentProps) {
  const { job, queueName, isDeadLetterQueue, rootQueue, source, root } = loaderData
  // One per verb, not one for the page. An operator may retry, resume and cancel
  // a job but not delete it, which is precisely what a single flag could not say.
  const mayRetry = useCan('job:retry')
  const mayResume = useCan('job:resume')
  const mayCancel = useCan('job:cancel')
  const mayDelete = useCan('job:delete')
  const fetcher = useFetcher<{ success?: boolean; affected?: number; message?: string; error?: string }>()
  const isLoading = fetcher.state !== 'idle'

  const state = job.state
  const unfinished = !isFinalState(state)
  const now = useLiveNow(loaderData.now, state === 'active')
  useRefreshWhileUnfinished(unfinished)

  const actionResult = fetcher.data
  const showError = actionResult && !actionResult.success && actionResult.affected === 0

  const submitAction = (intent: string) => {
    fetcher.submit({ intent }, { method: 'post' })
  }

  const times: JobTimes = {
    state,
    createdOn: job.createdOn,
    startAfter: job.startAfter,
    startedOn: job.startedOn,
    completedOn: job.completedOn,
    keepUntil: job.keepUntil,
    retryCount: job.retryCount,
    retryLimit: job.retryLimit,
    expireInSeconds: job.expireInSeconds,
    deleteAfterSeconds: job.deleteAfterSeconds,
  }
  const startedOn = toDate(job.startedOn)
  const canCancel = mayCancel && (state === 'created' || state === 'retry' || state === 'active')
  const canDelete = mayDelete && state !== 'active'

  const rows: ConfigRow[] = []
  const unset: string[] = []
  if (job.policy) rows.push({ label: 'Policy', value: job.policy })
  rows.push({ label: 'Priority', value: job.priority, mono: true })
  if (job.singletonKey) rows.push({ label: 'Singleton key', value: job.singletonKey, mono: true })
  else unset.push('singleton key')
  if (job.groupId) rows.push({ label: 'Group', value: job.groupTier ? `${job.groupId} (${job.groupTier})` : job.groupId, mono: true })
  else unset.push('group')
  if (job.expireInSeconds) rows.push({ label: 'Time limit', value: formatSeconds(job.expireInSeconds) })
  if (job.heartbeatSeconds) rows.push({ label: 'Heartbeat', value: `Every ${formatSeconds(job.heartbeatSeconds)}` })
  else unset.push('heartbeat')
  if (job.deadLetter) {
    rows.push({
      label: 'Dead letter queue',
      mono: true,
      value: (
        <DbLink to={`/queues/${encodeURIComponent(job.deadLetter)}`} className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300">
          {job.deadLetter}
        </DbLink>
      ),
    })
  } else {
    unset.push('dead letter queue')
  }

  let panel = null
  if (state === 'failed') {
    panel = <FailurePanel output={job.output} attempt={attempts(times)} maxAttempts={job.retryLimit + 1} deadLetter={job.deadLetter || null} />
  } else if (job.sourceId && job.sourceName) {
    panel = (
      <DeadLetterPanel
        sourceName={job.sourceName}
        sourceId={job.sourceId}
        sourceRetryCount={job.sourceRetryCount}
        sourceOutput={job.sourceOutput}
        sourceExists={!!source}
      />
    )
  } else if (state === 'active') {
    panel = <RunningPanel job={times} now={now} heartbeatOn={toDate(job.heartbeatOn)} heartbeatSeconds={job.heartbeatSeconds} />
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="pgb-eyebrow">Job in</span>
            <DbLink
              to={`/queues/${encodeURIComponent(queueName)}`}
              className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-300 dark:hover:text-primary-200"
            >
              {queueName}
            </DbLink>
            {isDeadLetterQueue && (
              <span
                title="At least one queue sends its failed jobs here"
                className="inline-flex items-center gap-1 rounded-full bg-[var(--state-failed-bg)] px-2 py-0.5 text-xs text-[var(--state-failed-fg)]"
              >
                <Inbox className="h-3 w-3" aria-hidden="true" />
                Dead letter queue
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-all font-mono text-xl font-medium tracking-[-0.01em] text-[var(--text-primary)] sm:text-2xl">
              {job.id}
            </h1>
            <CopyButton value={job.id} label="Copy job ID" />
            <StateBadge state={state} />
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            {state === 'active' && startedOn && (
              <>Running for <span className="tabular-nums text-[var(--text-primary)]">{formatDuration(now.getTime() - startedOn.getTime(), { live: true })}</span> · </>
            )}
            {statusLine(times, now, formatDate)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {showError && (
            <span className="text-xs text-[var(--warning-600)]" title={actionResult.message}>
              Action failed
            </span>
          )}
          {mayRetry && state === 'failed' && (
            <Button variant="primary" size="md" disabled={isLoading} onClick={() => submitAction('retry')}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Retry job
            </Button>
          )}
          {mayResume && state === 'cancelled' && (
            <Button variant="primary" size="md" disabled={isLoading} onClick={() => submitAction('resume')}>
              <Play className="mr-2 h-4 w-4" aria-hidden="true" />
              Resume job
            </Button>
          )}
          {canCancel && (
            <ConfirmDialog
              title="Cancel Job"
              description={`Are you sure you want to cancel job ${job.id}? This will prevent the job from being processed.`}
              confirmLabel="Cancel Job"
              confirmVariant="danger"
              triggerVariant="outline"
              trigger={<span className="inline-flex items-center gap-2"><Ban className="h-4 w-4" aria-hidden="true" />Cancel job</span>}
              onConfirm={() => submitAction('cancel')}
              disabled={isLoading}
            />
          )}
          {canDelete && (
            <ConfirmDialog
              title="Delete Job"
              description={`Are you sure you want to delete job ${job.id}? This action cannot be undone.`}
              confirmLabel="Delete"
              confirmVariant="danger"
              triggerVariant="ghost"
              trigger={<span className="inline-flex items-center gap-2 text-[var(--state-failed-fg)]"><Trash2 className="h-4 w-4" aria-hidden="true" />Delete</span>}
              onConfirm={() => submitAction('delete')}
              disabled={isLoading}
            />
          )}
        </div>
      </div>

      {panel}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <PayloadCard key={`${job.id}:${state}`} data={job.data} output={job.output} state={state} />
          <LineageCard
            jobId={job.id}
            queueName={queueName}
            state={state}
            sourceName={job.sourceName}
            sourceId={job.sourceId}
            sourceRootId={job.sourceRootId}
            sourceCreatedOn={job.sourceCreatedOn}
            sourceRetryCount={job.sourceRetryCount}
            sourceOutput={job.sourceOutput}
            rootQueue={rootQueue}
            root={root}
            source={source}
          />
        </div>
        <aside className="flex flex-col gap-6" aria-label="Job details">
          <TimelineCard job={times} now={now} />
          <RetriesCard
            retryCount={job.retryCount}
            retryLimit={job.retryLimit}
            retryDelay={job.retryDelay}
            retryBackoff={job.retryBackoff}
            retryDelayMax={job.retryDelayMax}
          />
          <ConfigCard rows={rows} unset={unset} />
        </aside>
      </div>
    </div>
  )
}
