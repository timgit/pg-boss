import { useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Instance } from '~/lib/types'
import type { InstancePageData } from '~/lib/instances.server'
import {
  formatAgo,
  formatConfig,
  formatSpan,
  instanceName,
  instanceRoles,
  isChangedOption,
  OPTION_DEFAULTS,
  instanceStatus,
  workByQueue,
  workSettings,
  type QueueWork,
} from '~/lib/instances'
import { Card } from '~/components/ui/card'
import { CLICKABLE_ROW, useRowClick } from '~/components/ui/table'
import { Badge } from '~/components/ui/badge'
import { PageHeader } from '~/components/ui/page-header'
import { DbLink } from '~/components/db-link'
import { StatusBadge } from '~/components/instances-table'
import { cn } from '~/lib/utils'

/** A column an overlay adds to the Workers table, after Active, read from one queue's work. */
export interface WorkerColumn {
  header: string
  align?: 'left' | 'right'
  Cell: (props: { work: QueueWork }) => ReactNode
}

/**
 * What an overlay that replaces an instance's page adds to the sections it composes. Every field is
 * optional, and without them the page is the free one.
 */
export interface InstancePageExtensions {
  /** Between the header and Workers. */
  afterHeader?: ReactNode
  workerColumns?: WorkerColumn[]
  /** More facts at the end of Process. */
  processRows?: Array<[string, ReactNode]>
  /** Beside Process. */
  besideProcess?: ReactNode
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-[var(--text-tertiary)]">{children}</span>

/** A titled card on the instance's page. */
export function InstanceSection ({ title, aside, children, className }: { title: string, aside?: ReactNode, children: ReactNode, className?: string }) {
  return (
    <Card className={cn('min-w-0', className)}>
      <section aria-label={title} className="grid gap-2 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="pgb-eyebrow">{title}</h2>
          {aside && <span className="pgb-num text-xs text-[var(--text-tertiary)]">{aside}</span>}
        </div>
        {children}
      </section>
    </Card>
  )
}

function Facts ({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-[var(--text-tertiary)]">{term}</dt>
          <dd className="pgb-num min-w-0 break-words text-[var(--text-secondary)]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const ago = (then: string | Date | null, now: Date) => (then ? formatAgo(then, now) : '—')
const on = (v: boolean) => (v ? 'on' : <Muted>off</Muted>)

/** The name, its short id and status, and the facts that identify the process. */
export function InstancePageHeader ({ instance: i, checkedOn }: { instance: Instance, checkedOn: Date }) {
  const status = instanceStatus(i)
  const roles = instanceRoles(i)
  const ran = formatSpan((i.stoppedOn ? new Date(i.stoppedOn) : i.live ? checkedOn : new Date(i.heartbeatOn)).getTime() - new Date(i.startedOn).getTime())

  return (
    <div className="grid gap-2">
      <PageHeader
        parent={{ to: '/instances', label: 'Instances' }}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Instance: <span className={cn(!i.name && 'font-normal italic')}>{instanceName(i.name)}</span></span>
            <span className="font-mono text-base font-medium text-[var(--text-tertiary)]" title={i.id}>{i.id.slice(0, 8)}</span>
            <StatusBadge status={status} />
          </span>
        }
        subtitle={
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <span><b className="font-medium text-[var(--text-secondary)]">{i.host}</b> · pid {i.pid}</span>
            <span>pg-boss <b className="font-medium text-[var(--text-secondary)]">{i.version}</b> · Node {i.nodeVersion}</span>
            <span>{status === 'live' ? 'up' : 'ran'} <b className="font-medium text-[var(--text-secondary)]">{ran}</b></span>
            <span>{i.stoppedOn ? `stopped ${ago(i.stoppedOn, checkedOn)}` : `heartbeat ${ago(i.heartbeatOn, checkedOn)}, every ${i.heartbeatSeconds}s`}</span>
          </span>
        }
      />
      {roles.length > 0 && (
        <div className="-mt-4 mb-2 flex flex-wrap gap-1.5">
          {roles.map((r) => <Badge key={r} size="sm">{r}</Badge>)}
        </div>
      )}
    </div>
  )
}

const WORK_HEAD = 'whitespace-nowrap px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]'

/**
 * The queues an instance works, one row each, opening to the `work()` calls on it and their settings.
 * A queue's Workers is its calls' `localConcurrency` added up. An instance working one queue shows it open.
 */
export function WorkersCard ({ instance: i, checkedOn, columns = [] }: { instance: Instance, checkedOn: Date, columns?: WorkerColumn[] }) {
  const groups = useMemo(() => workByQueue(i.workers), [i.workers])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(groups.length === 1 ? [groups[0].queue] : []))
  const toggle = (queue: string) => setOpen((previous) => {
    const next = new Set(previous)
    if (!next.delete(queue)) next.add(queue)
    return next
  })
  const slots = groups.reduce((n, g) => n + g.workers, 0)
  const busy = groups.reduce((n, g) => n + g.active, 0)
  const calls = i.workers.length

  return (
    <InstanceSection
      title="Workers"
      aside={calls > 0 ? `${calls} ${calls === 1 ? 'worker' : 'workers'} on ${groups.length} ${groups.length === 1 ? 'queue' : 'queues'} · ${busy} of ${slots} slots busy` : undefined}
    >
      {calls === 0
        ? <p className="text-[13px] text-[var(--text-tertiary)]">No work() calls. This instance only sends jobs{i.supervise ? ' and supervises' : ''}.</p>
        : (
          <div className="-mx-2 overflow-x-auto">
            <table className="min-w-full text-[13px]">
              {/* The band every list's header has. */}
              <thead className="bg-[var(--surface-sunken)]">
                <tr className="text-left">
                  <th className={WORK_HEAD}>Queue</th>
                  <th className={cn(WORK_HEAD, 'text-right')}>Workers</th>
                  <th className={cn(WORK_HEAD, 'text-right')}>Active</th>
                  {columns.map((c) => <th key={c.header} className={cn(WORK_HEAD, c.align === 'right' && 'text-right')}>{c.header}</th>)}
                  <th className={cn(WORK_HEAD, 'text-right')}>Last fetch</th>
                  <th className={cn(WORK_HEAD, 'text-right')}>Last job ended</th>
                  <th className={cn(WORK_HEAD, 'text-right')}>Last error</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <QueueWorkRows
                  key={group.queue}
                  group={group}
                  columns={columns}
                  open={open.has(group.queue)}
                  onToggle={() => toggle(group.queue)}
                  checkedOn={checkedOn}
                />
              ))}
            </table>
          </div>
          )}
    </InstanceSection>
  )
}

function Times ({ of: w, checkedOn }: { of: { lastFetchedOn: string | null, lastJobEndedOn: string | null, lastErrorOn: string | null }, checkedOn: Date }) {
  return (
    <>
      <td className="whitespace-nowrap px-2 py-1.5 text-right">{ago(w.lastFetchedOn, checkedOn)}</td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right">{ago(w.lastJobEndedOn, checkedOn)}</td>
      <td className={cn('whitespace-nowrap px-2 py-1.5 text-right', w.lastErrorOn ? 'text-[var(--state-failed-fg)]' : 'text-[var(--text-tertiary)]')}>{ago(w.lastErrorOn, checkedOn)}</td>
    </>
  )
}

function QueueWorkRows ({ group, columns, open, onToggle, checkedOn }: {
  group: QueueWork
  columns: WorkerColumn[]
  open: boolean
  onToggle: () => void
  checkedOn: Date
}) {
  const panel = useId()
  const span = 6 + columns.length
  // The whole row opens and closes the queue's calls, as its name does.
  const rowClick = useRowClick({ onClick: onToggle })

  return (
    <tbody className="pgb-num text-[var(--text-secondary)]">
      <tr className={cn('border-t border-[var(--border-subtle)]', CLICKABLE_ROW)} onClick={rowClick}>
        <td className="px-2 py-1.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={panel}
            className="flex min-h-7 cursor-pointer items-center gap-1 text-left font-medium text-[var(--text-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]"
          >
            <ChevronRight className={cn('h-4 w-4 shrink-0 text-[var(--text-tertiary)] transition-transform', open && 'rotate-90')} aria-hidden="true" />
            {group.queue}
          </button>
        </td>
        <td className="px-2 py-1.5 text-right">
          {group.workers}
          {group.calls.length > 1 && <span className="block text-[11.5px] text-[var(--text-tertiary)]">{group.calls.length} work() calls</span>}
        </td>
        <td className="px-2 py-1.5 text-right">{group.active}</td>
        {columns.map(({ header, align, Cell }) => (
          <td key={header} className={cn('px-2 py-1.5', align === 'right' && 'text-right')}><Cell work={group} /></td>
        ))}
        <Times of={group} checkedOn={checkedOn} />
      </tr>
      <tr id={panel} hidden={!open}>
        <td colSpan={span} className="bg-[var(--surface-sunken)] px-2 pb-3 pl-8 pt-1">
          <WorkCalls group={group} checkedOn={checkedOn} />
        </td>
      </tr>
    </tbody>
  )
}

const CALL_HEAD = 'whitespace-nowrap py-1 pr-4 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)]'

/** Each `work()` call on a queue: its shape and activity, then every option it set. */
function WorkCalls ({ group, checkedOn }: { group: QueueWork, checkedOn: Date }) {
  return (
    <div className="grid gap-2">
      <table className="text-[12.5px]">
        <thead>
          <tr>
            <th className={CALL_HEAD}>Worker</th>
            <th className={CALL_HEAD}>Concurrency × batch</th>
            <th className={CALL_HEAD}>Polling</th>
            <th className={cn(CALL_HEAD, 'text-right')}>In hand</th>
            <th className={cn(CALL_HEAD, 'text-right')}>Last fetch</th>
            <th className={cn(CALL_HEAD, 'text-right')}>Last job ended</th>
            <th className={cn(CALL_HEAD, 'text-right')}>Last error</th>
          </tr>
        </thead>
        {group.calls.map((w) => {
          const options = workSettings(w).slice(2)
          return (
            <tbody key={w.id}>
              <tr className="border-t border-[var(--border-default)]">
                <td className="py-1 pr-4 font-mono text-[var(--text-primary)]" title={w.id}>{w.id.slice(0, 8)}</td>
                <td className="py-1 pr-4 font-mono">{w.localConcurrency} × {w.batchSize}</td>
                <td className="py-1 pr-4 font-mono">{w.pollingIntervalSeconds == null ? <Muted>default</Muted> : `${w.pollingIntervalSeconds}s`}</td>
                <td className="py-1 pr-4 text-right font-mono">{w.active}</td>
                <Times of={w} checkedOn={checkedOn} />
              </tr>
              <tr>
                <td colSpan={7} className="pb-1.5 pr-4">
                  {options.length === 0
                    ? <Muted>Every other option at its default.</Muted>
                    : (
                      <span className="flex flex-wrap gap-1.5">
                        {options.map(([key, value]) => (
                          <code key={key} className="rounded-[5px] border border-[var(--border-default)] bg-[var(--surface-card)] px-1.5 py-px font-mono text-[11.5px] text-[var(--text-secondary)]">
                            {key}: {value}
                          </code>
                        ))}
                      </span>
                      )}
                </td>
              </tr>
            </tbody>
          )
        })}
      </table>
      <DbLink to={`/queues/${encodeURIComponent(group.queue)}`} className="justify-self-start text-[12.5px] text-[var(--primary-600)] dark:text-[var(--primary-400)] hover:underline">
        Queue page for {group.queue}
      </DbLink>
    </div>
  )
}

/** The process: its id, pool, connection name, times and recorded switches. */
export function ProcessCard ({ instance: i, checkedOn, extraRows = [] }: { instance: Instance, checkedOn: Date, extraRows?: Array<[string, ReactNode]> }) {
  return (
    <InstanceSection title="Process">
      <Facts
        rows={[
          ['Id', <span key="id" className="font-mono text-xs">{i.id}</span>],
          ['Pool', i.poolMax == null
            ? <Muted>passed in, so not counted</Muted>
            : `${i.poolTotal ?? 0} of ${i.poolMax} open, ${i.poolIdle ?? 0} idle${i.poolWaiting ? `, ${i.poolWaiting} waiting` : ''}`],
          ['application_name', <span key="app" className="font-mono text-xs">{i.applicationName ?? '—'}</span>],
          ['Started', `${new Date(i.startedOn).toLocaleString()}, ${ago(i.startedOn, checkedOn)}`],
          ['Heartbeat', `every ${i.heartbeatSeconds}s, last ${ago(i.heartbeatOn, checkedOn)}`],
          ['Queue stats', on(i.persistQueueStats)],
          ['Warnings', on(i.persistWarnings)],
          ...extraRows,
        ]}
      />
    </InstanceSection>
  )
}

/** The options it runs with, folded away: nobody needs all of them at a glance. */
export function OptionsCard ({ instance: i }: { instance: Instance }) {
  // Changed options first, so what someone set is read before the defaults around it.
  const config = Object.entries(i.config ?? {})
    .map(([key, value]) => ({ key, value, changed: isChangedOption(key, value) }))
    .sort((a, b) => Number(b.changed) - Number(a.changed) || a.key.localeCompare(b.key))
  const changed = config.filter((o) => o.changed).length

  return (
    <Card>
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="pgb-eyebrow">
            Options{' '}
            <span className="font-normal normal-case tracking-normal text-[var(--text-tertiary)]">
              · {config.length} recorded
              {changed > 0 && <>, <b className="font-medium text-[var(--primary-600)] dark:text-[var(--primary-400)]">{changed} changed from the default</b></>}
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--text-tertiary)] transition-transform group-open:rotate-90" />
        </summary>
        <div className="grid gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
          {config.length === 0
            ? <p className="text-[13px] text-[var(--text-tertiary)]">Every recorded option at its default.</p>
            : (
              <dl className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
                {config.map(({ key, value, changed }) => (
                  <div key={key} data-changed={changed || undefined} className="flex items-baseline justify-between gap-3 border-t border-[var(--border-subtle)] py-1.5 text-[12.5px] first:border-t-0">
                    <dt className={changed ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}>{key}</dt>
                    <dd className="min-w-0 text-right font-mono">
                      <span className={changed ? 'font-medium text-[var(--primary-600)] dark:text-[var(--primary-400)]' : 'text-[var(--text-secondary)]'}>{formatConfig(value)}</span>
                      {changed && <span className="ml-1.5 text-[11px] text-[var(--text-tertiary)]">· default {formatConfig(OPTION_DEFAULTS[key])}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
              )}
          <p className="text-xs text-[var(--text-tertiary)]">
            Changed options are compared with the current defaults. Connection settings are not saved for security reasons.
          </p>
        </div>
      </details>
    </Card>
  )
}

/** One registered instance: what it works, its process and its options. */
export function InstancePage ({ data, extensions }: { data: InstancePageData, extensions?: InstancePageExtensions }) {
  const { instance, checkedOn } = data

  return (
    <div className="grid gap-4">
      <InstancePageHeader instance={instance} checkedOn={checkedOn} />
      {extensions?.afterHeader}
      <WorkersCard instance={instance} checkedOn={checkedOn} columns={extensions?.workerColumns} />
      <div className={cn('grid items-start gap-4', extensions?.besideProcess && 'lg:grid-cols-2')}>
        {extensions?.besideProcess}
        <ProcessCard instance={instance} checkedOn={checkedOn} extraRows={extensions?.processRows} />
      </div>
      <OptionsCard instance={instance} />
    </div>
  )
}
