import { useEffect, useRef } from 'react'
import { useRevalidator } from 'react-router'
import { Inbox } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.$name.jobs.$jobId'
import { ProSlot } from '~/components/pro-slot'
import {
  getJobById,
  getJobPageContext,
  getLinkedJob,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
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
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => (params.jobId ? `Job ${params.jobId.slice(0, 8)} · ${params.name}` : null) }

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

  const state = job.state
  const unfinished = !isFinalState(state)
  const now = useLiveNow(loaderData.now, state === 'active')
  useRefreshWhileUnfinished(unfinished)

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
          <ProSlot name="jobActions" job={{ id: job.id, name: queueName, state }} />
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
