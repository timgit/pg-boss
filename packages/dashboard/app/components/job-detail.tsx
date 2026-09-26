import { useEffect, useId, useState, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronDown, CircleAlert, Copy, LoaderCircle, X } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import { Badge } from '~/components/ui/badge'
import { Card } from '~/components/ui/card'
import type { LinkedJob } from '~/lib/queries.server'
import {
  buildTimeline,
  expiresAt,
  formatDuration,
  formatSeconds,
  isFinalState,
  summarizeOutput,
  toDate,
  tokenizeJson,
  type JobState,
  type JobTimes,
  type TimelineItem,
} from '~/lib/job-detail'
import { cn, formatDateWithSeconds, JOB_STATE_VARIANTS } from '~/lib/utils'

// The database's clock, ticking. Seeded from the loader's `now` so the server render and the first
// client render agree, then advanced by the browser's clock plus the offset between the two.
export function useLiveNow (serverNow: string, live: boolean): Date {
  const serverMs = new Date(serverNow).getTime()
  const [now, setNow] = useState(serverMs)

  useEffect(() => {
    setNow(serverMs)
    if (!live) return
    const offset = serverMs - Date.now()
    const timer = setInterval(() => setNow(Date.now() + offset), 1000)
    return () => clearInterval(timer)
  }, [serverMs, live])

  return new Date(now)
}

export function LiveDot ({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex h-1.5 w-1.5 shrink-0', className)} aria-hidden="true">
      <span className="absolute inset-0 rounded-full bg-[var(--state-active-dot)] opacity-75 motion-safe:animate-ping" />
      <span className="relative inline-flex h-full w-full rounded-full bg-[var(--state-active-dot)]" />
    </span>
  )
}

export function StateBadge ({ state }: { state: JobState }) {
  if (state !== 'active') {
    return <Badge variant={JOB_STATE_VARIANTS[state]} size="lg" dot>{state}</Badge>
  }
  return (
    <Badge variant="primary" size="lg">
      <LiveDot className="mr-1.5" />
      active
    </Badge>
  )
}

export function CopyButton ({ value, label, children }: { value: string, label: string, children?: ReactNode }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={children ? undefined : label}
      title={copied ? 'Copied' : label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md cursor-pointer transition-colors',
        'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
        children ? 'px-1.5 py-1 text-[13px]' : 'h-[30px] w-[30px] justify-center border border-[var(--border-default)]'
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[var(--success-600)]" /> : <Copy className="h-3.5 w-3.5" />}
      {children && (copied ? 'Copied' : children)}
    </button>
  )
}

// Pretty-printed JSON with line numbers and coloured keys, strings and numbers.
export function JsonBlock ({ value, className }: { value: unknown, className?: string }) {
  const lines = tokenizeJson(value)
  const tone = {
    key: 'text-primary-600 dark:text-[var(--state-active-fg)]',
    string: 'text-[var(--success-700)] dark:text-[var(--state-completed-fg)]',
    number: 'text-[var(--warning-700)] dark:text-[var(--state-retry-fg)]',
    literal: 'text-[var(--warning-700)] dark:text-[var(--state-retry-fg)]',
    punct: 'text-[var(--text-tertiary)]',
  }

  return (
    <div className={cn('flex overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] py-3.5 font-mono text-[13px] leading-[22px]', className)}>
      <div aria-hidden="true" className="select-none px-3.5 text-right text-[var(--text-tertiary)] opacity-60">
        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <pre className="m-0 pr-4 whitespace-pre text-[var(--text-primary)]">
        {lines.map((tokens, i) => (
          <div key={i}>
            {tokens.map((token, j) => <span key={j} className={tone[token.kind]}>{token.text}</span>)}
            {tokens.length === 0 && ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

function Eyebrow ({ children, className, id }: { children: ReactNode, className?: string, id?: string }) {
  return <div id={id} className={cn('pgb-eyebrow', className)}>{children}</div>
}

function OutputFacts ({ output }: { output: unknown }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeOutput(output)
  const panelId = useId()

  return (
    <>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {summary.details.map(({ key, value }) => (
          <span key={key} className="rounded-md bg-[var(--surface-card)]/70 px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
            {key}: <span className="text-[var(--text-primary)]">{value}</span>
          </span>
        ))}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="inline-flex cursor-pointer items-center gap-1 px-1 py-0.5 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          {open ? 'Hide' : 'Show'} full output
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && <div id={panelId}><JsonBlock value={output} className="mt-2 max-h-72 bg-[var(--surface-card)]" /></div>}
    </>
  )
}

function ProblemPanel ({ eyebrow, headline, children, aside }: {
  eyebrow: string
  headline: string | null
  children: ReactNode
  aside?: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="flex gap-4 rounded-xl border border-[var(--state-failed-border)] bg-[var(--state-failed-bg)] px-6 py-5"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--state-failed-bg)] text-[var(--state-failed-fg)]">
        <CircleAlert className="h-[18px] w-[18px]" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 grow flex-col gap-2">
        <Eyebrow id={id} className="text-[var(--state-failed-fg)]">{eyebrow}</Eyebrow>
        <div className="break-words text-xl font-medium leading-snug text-[var(--text-primary)]">
          {headline ?? <span className="text-[var(--text-secondary)]">No error message was recorded</span>}
        </div>
        {children}
      </div>
      {aside}
    </section>
  )
}

export function FailurePanel ({ output, attempt, maxAttempts, deadLetter }: {
  output: unknown
  attempt: number
  maxAttempts: number
  deadLetter: string | null
}) {
  const { headline } = summarizeOutput(output)
  return (
    <ProblemPanel eyebrow="Error" headline={headline}>
      <div className="text-sm text-[var(--text-secondary)]">
        Attempt {attempt} of {maxAttempts}.{' '}
        {deadLetter
          ? <>A copy was sent to the dead letter queue <DbLink to={`/queues/${encodeURIComponent(deadLetter)}`} className="font-mono text-primary-600 dark:text-primary-400">{deadLetter}</DbLink>.</>
          : 'No retries left, so it stays failed until someone retries it.'}
      </div>
      <OutputFacts output={output} />
    </ProblemPanel>
  )
}

export function DeadLetterPanel ({ sourceName, sourceId, sourceRetryCount, sourceOutput, sourceExists }: {
  sourceName: string
  sourceId: string
  sourceRetryCount: number | null
  sourceOutput: unknown
  sourceExists: boolean
}) {
  const { headline } = summarizeOutput(sourceOutput)
  const tries = (sourceRetryCount ?? 0) + 1
  return (
    <ProblemPanel
      eyebrow="Why it's here"
      headline={headline}
      aside={sourceExists && (
        <DbLink
          to={`/queues/${encodeURIComponent(sourceName)}/jobs/${sourceId}`}
          className="inline-flex shrink-0 items-start gap-1.5 whitespace-nowrap text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
        >
          Open source job <ArrowRight className="mt-0.5 h-3.5 w-3.5" aria-hidden="true" />
        </DbLink>
      )}
    >
      <div className="text-sm text-[var(--text-secondary)]">
        Failed in{' '}
        <DbLink to={`/queues/${encodeURIComponent(sourceName)}`} className="font-mono text-primary-600 dark:text-primary-400">{sourceName}</DbLink>
        {tries === 1 ? ' on its first attempt' : ` after ${tries} attempts`}, then moved to this dead letter queue.
      </div>
      <OutputFacts output={sourceOutput} />
    </ProblemPanel>
  )
}

export function RunningPanel ({ job, now, heartbeatOn, heartbeatSeconds }: {
  job: JobTimes
  now: Date
  heartbeatOn: Date | null
  heartbeatSeconds: number | null
}) {
  const startedOn = toDate(job.startedOn)
  const expiry = expiresAt(job)
  const remaining = expiry ? expiry.getTime() - now.getTime() : null
  const cell = 'flex flex-col gap-1.5 px-6 py-[18px]'
  const divider = 'border-b md:border-b-0 md:border-r border-[color-mix(in_srgb,var(--state-active-dot)_20%,transparent)]'

  return (
    <section
      aria-label="Run status"
      className="grid grid-cols-1 md:grid-cols-3 rounded-xl border border-[color-mix(in_srgb,var(--state-active-dot)_35%,transparent)] bg-[var(--state-active-bg)]"
    >
      <div className={cn(cell, divider)}>
        <Eyebrow className="inline-flex items-center gap-1.5 text-[var(--state-active-fg)]">
          <LoaderCircle className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" />
          Running for
        </Eyebrow>
        <span role="timer" className="font-mono text-[22px] font-medium leading-tight tabular-nums text-[var(--text-primary)]">
          {startedOn ? formatDuration(now.getTime() - startedOn.getTime(), { live: true }) : '—'}
        </span>
        <span className="text-[13px] text-[var(--text-secondary)]">
          {startedOn ? `Started ${formatDateWithSeconds(startedOn)}` : 'Start time not recorded'}
        </span>
      </div>
      <div className={cn(cell, divider)}>
        <Eyebrow>Heartbeat</Eyebrow>
        {heartbeatSeconds
          ? (
            <>
              <span className="text-lg font-medium text-[var(--text-primary)]">Every {formatSeconds(heartbeatSeconds)}</span>
              <span className="text-[13px] text-[var(--text-secondary)]">
                {heartbeatOn ? `Last at ${formatDateWithSeconds(heartbeatOn)}` : 'None received yet'}
              </span>
            </>
            )
          : (
            <>
              <span className="text-lg font-medium text-[var(--text-primary)]">Off</span>
              <span className="text-[13px] text-[var(--text-secondary)]">Only the time limit applies</span>
            </>
            )}
      </div>
      <div className={cell}>
        {expiry && remaining !== null && remaining > 0
          ? (
            <>
              <Eyebrow>Expires in</Eyebrow>
              <span className="font-mono text-[22px] font-medium leading-tight tabular-nums text-[var(--text-primary)]">{formatDuration(remaining, { live: true })}</span>
              <span className="text-[13px] text-[var(--text-secondary)]">
                At {formatDateWithSeconds(expiry)} if not finished, a {formatSeconds(job.expireInSeconds ?? 0)} limit
              </span>
            </>
            )
          : expiry
            ? (
              <>
                <Eyebrow className="text-[var(--state-retry-fg)]">Past its time limit</Eyebrow>
                <span className="font-mono text-[22px] font-medium leading-tight tabular-nums text-[var(--text-primary)]">{formatDuration(-(remaining ?? 0), { live: true })} over</span>
                <span className="text-[13px] text-[var(--text-secondary)]">Maintenance fails it on its next pass</span>
              </>
              )
            : (
              <>
                <Eyebrow>Time limit</Eyebrow>
                <span className="text-lg font-medium text-[var(--text-primary)]">None</span>
              </>
              )}
      </div>
    </section>
  )
}

export function PayloadCard ({ data, output, state }: { data: unknown, output: unknown, state: JobState }) {
  const hasOutput = output !== null && output !== undefined
  const [tab, setTab] = useState<'data' | 'output'>(state === 'completed' && hasOutput ? 'output' : 'data')
  const id = useId()
  const current = tab === 'data' ? data : output
  const outputNote = hasOutput ? null : isFinalState(state) ? 'empty' : 'when it finishes'
  const tabs: { key: 'data' | 'output', label: string, note: string | null }[] = state === 'completed' && hasOutput
    ? [{ key: 'output', label: 'Output', note: null }, { key: 'data', label: 'Data', note: null }]
    : [{ key: 'data', label: 'Data', note: null }, { key: 'output', label: 'Output', note: outputNote }]

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5">
        <div role="tablist" aria-label="Payload" className="flex gap-5">
          {tabs.map(({ key, label, note }) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${id}-${key}`}
              aria-selected={tab === key}
              aria-controls={`${id}-panel`}
              onClick={() => setTab(key)}
              className={cn(
                'cursor-pointer border-b-2 pb-3 pt-3.5 text-sm font-medium transition-colors',
                tab === key
                  ? 'border-primary-600 text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
              )}
            >
              {label}
              {note && <span className="text-xs font-normal"> · {note}</span>}
            </button>
          ))}
        </div>
        {(current !== null && current !== undefined) && (
          <CopyButton value={JSON.stringify(current, null, 2)} label="Copy JSON">Copy JSON</CopyButton>
        )}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="p-5">
        {current === null || current === undefined
          ? <p className="py-6 text-center text-sm text-[var(--text-tertiary)]">
              {tab === 'data' ? 'This job was sent without data.' : isFinalState(state) ? 'This job finished without output.' : 'Output is written when the job finishes.'}
            </p>
          : <JsonBlock value={current} className="max-h-96" />}
      </div>
    </Card>
  )
}

const DOT = 'mt-1 h-2.5 w-2.5 shrink-0 rounded-full'

function TimelineMarker ({ tone }: { tone: TimelineItem['tone'] }) {
  switch (tone) {
    case 'live': return <LiveDot className="mt-1 h-2.5 w-2.5" />
    case 'failed': return <span className={cn(DOT, 'bg-[var(--state-failed-dot)]')} />
    case 'completed': return <span className={cn(DOT, 'bg-[var(--state-completed-dot)]')} />
    case 'pending': return <span className={cn(DOT, 'border-[1.5px] border-[var(--border-strong)]')} />
    case 'retried': return <span className={cn(DOT, 'border-[1.5px] border-dashed border-[var(--text-tertiary)]')} />
    case 'retention': return <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[2px] border-[1.5px] border-[var(--border-strong)]" />
    default: return <span className={cn(DOT, 'bg-[var(--state-created-dot)]')} />
  }
}

export function TimelineCard ({ job, now }: { job: JobTimes, now: Date }) {
  const items = buildTimeline(job, now)
  const startedOn = toDate(job.startedOn)

  return (
    <Card className="px-5 py-[18px]">
      <h2 className="mb-4 text-[15px] font-semibold text-[var(--text-primary)]">Timeline</h2>
      <ol className="flex flex-col">
        {items.map((item, i) => {
          const muted = item.tone === 'pending' || item.tone === 'retention'
          const detail = item.tone === 'live' && startedOn
            ? `running for ${formatDuration(now.getTime() - startedOn.getTime(), { live: true })}`
            : item.detail
          return (
            <li key={item.key} className="flex gap-3">
              <div className="flex flex-col items-center" aria-hidden="true">
                <TimelineMarker tone={item.tone} />
                {i < items.length - 1 && <span className="w-px grow bg-[var(--border-default)]" />}
              </div>
              <div className={cn('flex flex-col gap-0.5', i < items.length - 1 && 'pb-4')}>
                <span className={cn(
                  'text-sm font-medium',
                  item.tone === 'failed' && 'text-[var(--state-failed-fg)]',
                  item.tone === 'completed' && 'text-[var(--state-completed-fg)]',
                  item.tone === 'live' && 'text-[var(--state-active-fg)]',
                  muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'
                )}>
                  {item.label}
                </span>
                <span className={cn('text-[13px] tabular-nums', muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]')}>
                  {[item.at ? formatDateWithSeconds(item.at) : null, detail].filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

export function RetriesCard ({ retryCount, retryLimit, retryDelay, retryBackoff, retryDelayMax }: {
  retryCount: number
  retryLimit: number
  retryDelay: number
  retryBackoff: boolean
  retryDelayMax?: number | null
}) {
  return (
    <Card className="flex flex-col gap-3.5 px-5 py-[18px]">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Retries</h2>
        <span className="text-sm text-[var(--text-secondary)]">
          <span className="font-mono text-[var(--text-primary)]">{retryCount}</span> of{' '}
          <span className="font-mono text-[var(--text-primary)]">{retryLimit}</span> used
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <dt className="pgb-eyebrow">Delay</dt>
          <dd className="text-sm text-[var(--text-primary)]">{retryDelay ? formatSeconds(retryDelay) : 'None'}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="pgb-eyebrow">Backoff</dt>
          <dd className="text-sm text-[var(--text-primary)]">
            {retryBackoff ? (retryDelayMax ? `On, up to ${formatSeconds(retryDelayMax)}` : 'On') : 'Off'}
          </dd>
        </div>
      </dl>
    </Card>
  )
}

export interface ConfigRow {
  label: string
  value: ReactNode
  mono?: boolean
}

// The settings this job has, followed by one line naming the optional ones it doesn't.
export function ConfigCard ({ rows, unset }: { rows: ConfigRow[], unset: string[] }) {
  return (
    <Card className="flex flex-col gap-3 px-5 py-[18px]">
      <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Configuration</h2>
      <dl className="flex flex-col">
        {rows.map(({ label, value, mono }) => (
          <div key={label} className="flex justify-between gap-4 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
            <dt className="text-sm text-[var(--text-secondary)]">{label}</dt>
            <dd className={cn('min-w-0 break-all text-right text-sm text-[var(--text-primary)]', mono && 'font-mono text-[13px]')}>{value}</dd>
          </div>
        ))}
        {unset.length > 0 && (
          <div className="flex justify-between gap-4 py-2">
            <dt className="shrink-0 text-sm text-[var(--text-secondary)]">Not set</dt>
            <dd className="text-right text-[13px] text-[var(--text-tertiary)]">{unset.join(', ')}</dd>
          </div>
        )}
      </dl>
    </Card>
  )
}

export interface LineageProps {
  jobId: string
  queueName: string
  state: JobState
  sourceName: string | null
  sourceId: string | null
  sourceRootId: string | null
  sourceCreatedOn: Date | string | null
  sourceRetryCount: number | null
  sourceOutput: unknown
  rootQueue: string
  root: LinkedJob | null
  source: LinkedJob | null
}

function shortId (id: string) {
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

type NodeKey = 'root' | 'source'

// Root → ··· → Source → This job. Two lineage columns are stored, so the chain never has more than
// three boxes; whatever happened between the root and the source is not recorded and is drawn as a
// gap. A redriven job has a root and no source, and a first dead-lettering has a source that is
// its own root.
export function LineageCard (props: LineageProps) {
  const { jobId, queueName, state, sourceName, sourceId, sourceRootId, rootQueue, root, source } = props
  const showRoot = !!sourceRootId && sourceRootId !== sourceId
  const showSource = !!sourceId && !!sourceName
  const [open, setOpen] = useState<NodeKey | null>(showSource ? 'source' : showRoot ? 'root' : null)
  const panelId = useId()

  if (!showRoot && !showSource) return null

  const toggle = (key: NodeKey) => setOpen(open === key ? null : key)
  const node = (key: NodeKey) => cn(
    'flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1.5 rounded-[10px] border px-3.5 py-3 text-left transition-colors',
    open === key
      ? 'border-primary-500 bg-[var(--surface-hover)]'
      : 'border-[var(--border-default)] bg-[var(--surface-card)] hover:border-[var(--border-strong)]'
  )

  // A gap for the unrecorded hops, a red arrow for a failure moving a job, a plain one for a redrive.
  const connector = (label: string, kind: 'gap' | 'dead-lettered' | 'redriven') => (
    <div className="flex w-full shrink-0 flex-row items-center justify-center gap-2 md:w-24 md:flex-col md:gap-1" aria-hidden="true">
      <span className={cn('text-[11px]', kind === 'dead-lettered' ? 'text-[var(--state-failed-fg)]' : 'text-[var(--text-tertiary)]')}>{label}</span>
      {kind === 'gap'
        ? <span className="h-4 border-l border-dashed border-[var(--border-strong)] md:h-0 md:w-12 md:border-l-0 md:border-t" />
        : <ArrowRight className={cn('h-4 w-4 rotate-90 md:rotate-0', kind === 'dead-lettered' ? 'text-[var(--state-failed-fg)]' : 'text-[var(--text-secondary)]')} />}
    </div>
  )

  return (
    <Card className="flex flex-col gap-4 px-5 pb-5 pt-[18px]">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Lineage</h2>
        <span className="text-[13px] text-[var(--text-tertiary)]">Select a job to see its timeline</span>
      </div>

      <div className="flex flex-col items-stretch md:flex-row md:items-center">
        {showRoot && (
          <button type="button" className={node('root')} aria-expanded={open === 'root'} aria-controls={panelId} onClick={() => toggle('root')}>
            <span className="pgb-eyebrow">Root</span>
            <span className="font-mono text-[13px] text-primary-600 dark:text-[var(--state-active-fg)]">{shortId(sourceRootId!)}</span>
            <span className="text-[13px] text-[var(--text-secondary)]">
              in {rootQueue}{root ? ` · ${root.state}` : ' · not found'}
            </span>
          </button>
        )}
        {showRoot && (showSource ? connector('earlier', 'gap') : connector('redriven', 'redriven'))}
        {showSource && (
          <button type="button" className={node('source')} aria-expanded={open === 'source'} aria-controls={panelId} onClick={() => toggle('source')}>
            <span className="pgb-eyebrow">Source</span>
            <span className="font-mono text-[13px] text-primary-600 dark:text-[var(--state-active-fg)]">{shortId(sourceId!)}</span>
            <span className="text-[13px] text-[var(--text-secondary)]">
              in {sourceName} · <span className="text-[var(--state-failed-fg)]">failed</span>
              {props.sourceRetryCount !== null && `, ${props.sourceRetryCount} ${props.sourceRetryCount === 1 ? 'retry' : 'retries'}`}
            </span>
          </button>
        )}
        {showSource && connector('dead-lettered', 'dead-lettered')}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-[10px] border border-primary-500 bg-[color-mix(in_srgb,var(--state-active-dot)_10%,transparent)] px-3.5 py-3">
          <span className="pgb-eyebrow text-[var(--state-active-fg)]">This job</span>
          <span className="font-mono text-[13px] text-[var(--text-primary)]">{shortId(jobId)}</span>
          <span className="text-[13px] text-[var(--text-secondary)]">in {queueName} · {state}</span>
        </div>
      </div>

      {open === 'root' && showRoot && (
        <LinkedJobPanel id={panelId} role="Root job" jobId={sourceRootId!} queue={rootQueue} linked={root} onClose={() => setOpen(null)} />
      )}
      {open === 'source' && showSource && (
        <LinkedJobPanel
          id={panelId}
          role="Source job"
          jobId={sourceId!}
          queue={sourceName!}
          linked={source}
          stored={{ createdOn: toDate(props.sourceCreatedOn), retryCount: props.sourceRetryCount, output: props.sourceOutput }}
          onClose={() => setOpen(null)}
        />
      )}
    </Card>
  )
}

// One linked job's timeline, from its own row when it still exists, otherwise from what was copied
// onto this job when it was dead-lettered.
function LinkedJobPanel ({ id, role, jobId, queue, linked, stored, onClose }: {
  id: string
  role: string
  jobId: string
  queue: string
  linked: LinkedJob | null
  stored?: { createdOn: Date | null, retryCount: number | null, output: unknown }
  onClose: () => void
}) {
  const createdOn = toDate(linked?.createdOn) ?? stored?.createdOn ?? null
  const startedOn = toDate(linked?.startedOn)
  const completedOn = toDate(linked?.completedOn)
  const output = linked ? linked.output : stored?.output
  const retryCount = linked ? linked.retryCount : stored?.retryCount ?? null
  const finishLabel = linked?.state === 'completed' ? 'Completed' : linked?.state === 'cancelled' ? 'Cancelled' : 'Failed'
  const { headline } = summarizeOutput(output)
  const known = !!linked || !!stored

  const steps: { label: string, at: Date | null, missing: boolean, failed?: boolean }[] = [
    { label: 'Created', at: createdOn, missing: !createdOn },
    { label: 'Started', at: startedOn, missing: !startedOn },
    { label: finishLabel, at: completedOn, missing: !completedOn, failed: finishLabel === 'Failed' },
  ]

  return (
    <div id={id} className="flex flex-col gap-3.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--surface-sunken)] px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="pgb-eyebrow">{role}</span>
          <span className="break-all font-mono text-[13px] text-[var(--text-primary)]">{jobId}</span>
          {linked
            ? <Badge variant={JOB_STATE_VARIANTS[linked.state]} dot>{linked.state}</Badge>
            : <Badge variant="gray">no longer stored</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {linked && (
            <DbLink
              to={`/queues/${encodeURIComponent(queue)}/jobs/${jobId}`}
              className="whitespace-nowrap text-[13px] font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              Open job →
            </DbLink>
          )}
          <button
            type="button"
            aria-label={`Close ${role.toLowerCase()} timeline`}
            onClick={onClose}
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {!known
        ? (
          <p className="text-[13px] text-[var(--text-secondary)]">
            This job isn't in {queue} any more, so its timeline isn't available. It has most likely passed its
            retention and been deleted. Only its id is kept on the jobs copied from it.
          </p>
          )
        : (
          <>
            <ol className="grid grid-cols-3">
              {steps.map((step, i) => (
                <li key={step.label} className="flex flex-col gap-1.5">
                  <div className="flex items-center" aria-hidden="true">
                    <span className={cn(
                      'h-2.5 w-2.5 shrink-0 rounded-full',
                      step.missing
                        ? 'border-[1.5px] border-dashed border-[var(--border-strong)]'
                        : step.failed ? 'bg-[var(--state-failed-dot)]' : 'bg-[var(--state-created-dot)]'
                    )} />
                    {i < steps.length - 1 && <span className={cn('h-px grow', step.missing ? 'border-t border-dashed border-[var(--border-strong)]' : 'bg-[var(--border-default)]')} />}
                  </div>
                  <span className={cn('text-[13px] font-medium', step.failed && !step.missing ? 'text-[var(--state-failed-fg)]' : step.missing ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]')}>
                    {step.label}
                  </span>
                  <span className={cn('font-mono text-xs', step.missing ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]')}>
                    {step.at ? formatDateWithSeconds(step.at) : 'not kept'}
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
              {headline && <span className="text-[var(--state-failed-fg)]">{headline}</span>}
              {headline && retryCount !== null && <span className="text-[var(--text-tertiary)]">·</span>}
              {retryCount !== null && <span className="text-[var(--text-secondary)]">{retryCount} {retryCount === 1 ? 'retry' : 'retries'} used</span>}
            </div>
            {!linked && (
              <p className="text-xs text-[var(--text-tertiary)]">
                The source job has been deleted. Its creation time, retries and output were copied onto this job, so they're still shown.
              </p>
            )}
          </>
          )}
    </div>
  )
}
