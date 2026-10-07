import type { ReactNode } from 'react'
import type { Route } from './+types/migrations.$id'
import { getBamEntry } from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import { DbLink } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { CopyButton } from '~/components/job-detail'
import { formatSpan } from '~/lib/instances'
import { BAM_STATUS_LABELS, BAM_STATUS_VARIANTS, cn } from '~/lib/utils'
import type { BamEntryResult } from '~/lib/types'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => (params.id ? `Migration ${params.id.slice(0, 8)}` : null) }

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  // Not a uuid is no migration, rather than a database error.
  const entry = /^[0-9a-f-]{36}$/i.test(params.id) ? await getBamEntry(DB_URL, SCHEMA, params.id) : null

  if (!entry) {
    throw new Response('No such migration.', { status: 404, statusText: 'Not found' })
  }

  return { entry, checkedOn: new Date().toISOString() }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Failed to load the migration" error={error} backTo={{ href: '/migrations', label: 'Back to migrations' }} />
}

/** What a migration's command does, read from the SQL: "Builds the index", or a plainer fallback. */
function whatItDoes (command: string): { verb: string, noun: string } {
  if (/\bCREATE\s+UNIQUE\s+INDEX\b/i.test(command)) return { verb: 'Builds the unique index', noun: 'a unique index' }
  if (/\bCREATE\s+INDEX\b/i.test(command)) return { verb: 'Builds the index', noun: 'an index' }
  if (/\bDROP\s+INDEX\b/i.test(command)) return { verb: 'Drops the index', noun: 'dropping an index' }
  if (/\bREINDEX\b/i.test(command)) return { verb: 'Rebuilds the index', noun: 'a rebuilt index' }
  return { verb: 'Runs', noun: 'a change' }
}

/** A moment on the timeline: "today, 3:21 PM", or "Oct 6, 3:21 PM" on another day. */
function clock (value: Date | string, now: Date): string {
  const at = new Date(value)
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? `today, ${time}`
    : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

const span = (from: Date | string, to: Date | string) => formatSpan(new Date(to).getTime() - new Date(from).getTime())

type Dot = 'neutral' | 'active' | 'ok' | 'failed' | 'next' | 'running'

const DOT: Record<Dot, string> = {
  neutral: 'bg-[var(--text-tertiary)]',
  active: 'bg-[var(--state-active-fg)]',
  ok: 'bg-[var(--state-completed-fg)]',
  failed: 'bg-[var(--state-failed-fg)]',
  // What has not happened yet: hollow and dashed.
  next: 'border-2 border-dashed border-[var(--border-strong)]',
  running: 'border-2 border-dashed border-[var(--state-active-fg)]',
}

interface Moment {
  key: string
  dot: Dot
  title: ReactNode
  detail: ReactNode
  muted?: boolean
}

/**
 * What has happened to a migration, in order. pg-boss keeps three times for it: when it was queued,
 * and when its latest run started and ended. A retry overwrites the last two, so this is the latest
 * attempt; earlier ones leave no trace.
 */
function Timeline ({ entry, now }: { entry: BamEntryResult, now: Date }) {
  const ago = (value: Date | string) => `${formatSpan(now.getTime() - new Date(value).getTime())} ago`
  const moments: Moment[] = [
    { key: 'queued', dot: 'neutral', title: 'Queued', detail: `${ago(entry.createdOn)} · ${clock(entry.createdOn, now)} · by the upgrade to version ${entry.version}` },
  ]

  if (entry.startedOn) {
    moments.push({ key: 'started', dot: 'active', title: 'Started', detail: `${ago(entry.startedOn)} · ${clock(entry.startedOn, now)} · waited ${span(entry.createdOn, entry.startedOn)}` })
  }

  if (entry.status === 'pending') {
    moments.push({ key: 'waiting', dot: 'next', title: 'Not started', detail: 'Waiting its turn: one migration runs at a time, oldest first', muted: true })
    moments.push({ key: 'completes', dot: 'next', title: 'Completes', detail: 'When its command finishes', muted: true })
  } else if (entry.status === 'in_progress' && entry.startedOn) {
    moments.push({ key: 'running', dot: 'running', title: `Running for ${span(entry.startedOn, now)}`, detail: 'Other migrations wait until it ends' })
  } else if (entry.status === 'completed' && entry.completedOn) {
    moments.push({ key: 'done', dot: 'ok', title: 'Completed', detail: `${clock(entry.completedOn, now)}${entry.startedOn ? ` · ran ${span(entry.startedOn, entry.completedOn)}` : ''}` })
  } else if (entry.status === 'failed') {
    moments.push({
      key: 'failed',
      dot: 'failed',
      title: 'Failed',
      detail: entry.completedOn
        ? `${clock(entry.completedOn, now)}${entry.startedOn ? ` · ran ${span(entry.startedOn, entry.completedOn)}` : ''}`
        : 'When it ended was not recorded',
    })
    moments.push({ key: 'retry', dot: 'next', title: 'Tried again by itself', detail: 'Once no migration is pending. If the cause is still there, it fails the same way', muted: true })
  }

  return (
    <ol className="grid">
      {moments.map((m, k) => (
        <li key={m.key} className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
          {/* The line joining one moment to the next. */}
          {k < moments.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[6px] top-4 w-px bg-[var(--border-subtle)]" />}
          <span aria-hidden="true" className={cn('relative mt-1 box-border h-[11px] w-[11px] rounded-full', DOT[m.dot])} />
          <div className="grid gap-0.5">
            <span className={cn('text-sm font-medium', m.muted ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]')}>{m.title}</span>
            <span className="text-xs text-[var(--text-tertiary)]">{m.detail}</span>
          </div>
        </li>
      ))}
    </ol>
  )
}

const eyebrow = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]'
const queueLink = 'font-mono text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'

export default function MigrationDetail ({ loaderData }: Route.ComponentProps) {
  const { entry } = loaderData
  const now = new Date(loaderData.checkedOn)
  const does = whatItDoes(entry.command)
  const concurrent = /\bCONCURRENTLY\b/i.test(entry.command)
  const status = entry.status === 'in_progress' && entry.startedOn
    ? `Running for ${span(entry.startedOn, now)}`
    : BAM_STATUS_LABELS[entry.status]

  return (
    <div className="space-y-4">
      <PageHeader
        parent={{ to: '/migrations', label: 'Migrations' }}
        title={`Migration: ${entry.name}`}
        subtitle={(
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={BAM_STATUS_VARIANTS[entry.status]} size="sm" dot>{status}</Badge>
            <span>Schema version {entry.version} · {does.noun} on {entry.table}</span>
          </span>
        )}
      />

      {entry.status === 'failed' && entry.error && (
        <section aria-label="Error" className="grid gap-1.5 rounded-[10px] border border-[var(--state-failed-fg)]/40 bg-[var(--state-failed-bg)] px-5 py-4">
          <h2 className={cn(eyebrow, 'text-[var(--state-failed-fg)]')}>Error</h2>
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-[var(--text-primary)]">{entry.error}</pre>
        </section>
      )}

      <div className="flex flex-wrap items-start gap-4">
        <div className="grid min-w-0 flex-[999_1_560px] gap-4">
          <Card>
            <CardContent className="grid gap-4 p-5">
              <h2 className={eyebrow}>Summary</h2>
              <p className="text-[15px] leading-relaxed text-[var(--text-primary)]">
                {does.verb} <span className="font-mono">{entry.name}</span> on <span className="font-mono">{entry.table}</span>
                {entry.queue
                  ? <>, for the jobs of <DbLink to={`/queues/${encodeURIComponent(entry.queue)}`} className={queueLink}>{entry.queue}</DbLink></>
                  : ', for every queue'}
                .{concurrent && ' It runs in the background, without locking the table.'}
              </p>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-[var(--text-tertiary)]">Version</dt>
                <dd className="pgb-num text-[var(--text-secondary)]">{entry.version}</dd>
                <dt className="text-[var(--text-tertiary)]">Table</dt>
                <dd className="font-mono text-[var(--text-secondary)]">{entry.table}</dd>
                <dt className="text-[var(--text-tertiary)]">Queue</dt>
                <dd className="text-[var(--text-secondary)]">
                  {entry.queue
                    ? <DbLink to={`/queues/${encodeURIComponent(entry.queue)}`} className={queueLink}>{entry.queue}</DbLink>
                    : 'Every queue'}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Command</CardTitle>
              <CopyButton value={entry.command} label="Copy the command" />
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-sunken)] p-4 font-mono text-xs leading-relaxed text-[var(--text-secondary)]">
                {entry.command}
              </pre>
            </CardContent>
          </Card>
        </div>

        <Card className="flex-[1_1_320px]">
          <CardContent className="grid gap-4 p-5">
            <h2 className={eyebrow}>Timeline</h2>
            <Timeline entry={entry} now={now} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
