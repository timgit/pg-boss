import { useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Connections, Instance } from '~/lib/types'
import type { InstancePageData } from '~/lib/instances.server'
import {
  formatAgo,
  formatBytes,
  formatConfig,
  formatCores,
  formatMs,
  formatSpan,
  instanceName,
  passOptions,
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
import { CopyButton } from '~/components/job-detail'
import { cn, formatDateWithSeconds } from '~/lib/utils'

/** A column an overlay adds to the Workers table, after Active, read from one queue's work. */
export interface WorkerColumn {
  header: string
  align?: 'left' | 'right'
  Cell: (props: { work: QueueWork }) => ReactNode
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

function Facts ({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
      {rows.map(([term, value], k) => (
        <div key={k} className="contents">
          <dt className="text-[var(--text-tertiary)]">{term}</dt>
          <dd className="pgb-num min-w-0 break-words text-[var(--text-secondary)]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const ago = (then: string | Date | null, now: Date) => (then ? formatAgo(then, now) : '—')

/** The name, its short id and status, and the facts that identify the process. */
export function InstancePageHeader ({ instance: i, checkedOn }: { instance: Instance, checkedOn: Date }) {
  const status = instanceStatus(i)
  const options = passOptions(i)
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
      {options.length > 0 && (
        <div className="-mt-4 mb-2 flex flex-wrap gap-1.5" aria-label="Options on">
          {options.map((o) => <Badge key={o} size="sm" className="font-mono">{o}</Badge>)}
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
  // Workers are localConcurrency added up, as core counts them. A slot holds one job, so each call
  // has localConcurrency × batchSize of them, the most jobs it can have active at once.
  const workers = groups.reduce((n, g) => n + g.workers, 0)
  const slots = i.workers.reduce((n, w) => n + w.localConcurrency * w.batchSize, 0)
  const busy = groups.reduce((n, g) => n + g.active, 0)
  const calls = i.workers.length

  return (
    <InstanceSection
      title="Workers"
      aside={calls > 0 ? `${workers} ${workers === 1 ? 'worker' : 'workers'} on ${groups.length} ${groups.length === 1 ? 'queue' : 'queues'} · ${busy} of ${slots} slots busy` : undefined}
    >
      {calls === 0
        ? <p className="text-[13px] text-[var(--text-tertiary)]">No work() calls.</p>
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
            <th className={CALL_HEAD}>Id</th>
            <th className={CALL_HEAD}>Concurrency × batch</th>
            <th className={CALL_HEAD}>Polling</th>
            <th className={cn(CALL_HEAD, 'text-right')}>Active</th>
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

/** A date, with how long ago it was under it. */
const When = ({ at, sub }: { at: string | Date, sub: ReactNode }) => (
  <>
    <span className="text-[var(--text-primary)]">{formatDateWithSeconds(new Date(at))}</span>
    <span className="block text-xs text-[var(--text-tertiary)]">{sub}</span>
  </>
)

/** A fact whose value is too long to sit beside its label, so it goes under it. */
function Stacked ({ label, action, children }: { label: ReactNode, action?: ReactNode, children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <div className="flex min-h-[30px] items-center justify-between gap-2 text-xs text-[var(--text-tertiary)]">
        <span>{label}</span>
        {action}
      </div>
      <div className="min-w-0 break-all font-mono text-xs text-[var(--text-primary)]">{children}</div>
    </div>
  )
}

/** What Postgres has open under the instance's `application_name` now. */
function PostgresConnections ({ instance: i, connections }: { instance: Instance, connections: Connections | null }) {
  if (!i.applicationName) return <Muted>not named, so not traceable</Muted>
  if (!connections) return <Muted>—</Muted>
  const b = connections.byApp[i.applicationName]
  if (!b) return <>none open</>
  return (
    <>
      {b.total} open, {b.active} active, {b.idle} idle
      {b.idleInTransaction > 0 && (
        <b className="block font-medium text-[var(--state-failed-fg)]">
          {b.idleInTransaction} idle in a transaction
          {b.oldestIdleInTransactionSeconds != null && ` for ${formatSpan(b.oldestIdleInTransactionSeconds * 1000)}`}
        </b>
      )}
    </>
  )
}

/**
 * The process: its id and connection name, when it started and last beat, what Postgres has open
 * under its name now, and its crash restarts. Its pool is a tile, as pg-boss reported it.
 */
export function ProcessCard ({ instance: i, checkedOn, connections }: { instance: Instance, checkedOn: Date, connections: Connections | null }) {
  const beat = ago(i.heartbeatOn, checkedOn)

  return (
    <InstanceSection title="Process">
      <div className="grid gap-2.5">
        <Stacked label="Id" action={<CopyButton value={i.id} label="Copy id" />}>{i.id}</Stacked>
        <Stacked label={<>Connection name <code className="font-mono text-[11px]">application_name</code></>}>
          {i.applicationName ?? <Muted>not set</Muted>}
        </Stacked>
        <hr className="border-[var(--border-subtle)]" />
        <Facts
          rows={[
            ['Started', <When key="started" at={i.startedOn} sub={ago(i.startedOn, checkedOn)} />],
            ['Last heartbeat', <When key="beat" at={i.heartbeatOn} sub={i.stoppedOn ? beat : `${beat}, expected every ${i.heartbeatSeconds}s`} />],
            [<>Connections<br />in Postgres now</>, <PostgresConnections key="connections" instance={i} connections={connections} />],
            ...(i.crashRestarts > 0
              ? [['Crash restarts', (
                  <span key="crashes">
                    <span className="text-[var(--text-primary)]">
                      {i.crashRestarts}{i.crashRestartsSince && ` since ${formatDateWithSeconds(new Date(i.crashRestartsSince))}`}
                    </span>
                    <span className="block text-xs text-[var(--text-tertiary)]">counted by name on this host</span>
                  </span>
                  )] as [ReactNode, ReactNode]]
              : []),
          ]}
        />
      </div>
    </InstanceSection>
  )
}

/** One resource at the last heartbeat, against its limit. */
function ResourceTile ({ label, value, of, share, hot, host, note }: {
  label: string
  value: ReactNode
  of?: ReactNode
  share?: number | null
  hot?: boolean
  host?: boolean
  note?: ReactNode
}) {
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-[var(--border-default)] px-4 py-3 shadow-sm"
      style={{ background: 'var(--surface-card-grad)' }}
    >
      <span className="pgb-eyebrow">{label}</span>
      <div className={cn('pgb-num text-[24px] font-semibold leading-tight tracking-[-0.02em]', hot ? 'text-[var(--state-retry-fg)]' : 'text-[var(--text-primary)]')}>
        {value}
        {of && <small className="ml-1 text-[13px] font-medium tracking-normal text-[var(--text-tertiary)]">{of}</small>}
      </div>
      {share != null && (
        <span className="block h-1.5 overflow-hidden rounded bg-[var(--surface-sunken)]">
          <span className={cn('block h-full rounded', hot ? 'bg-[var(--warning-500)]' : host ? 'pgb-host-bar' : 'bg-[var(--primary-500)]')} style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }} />
        </span>
      )}
      {note && <p className="text-xs text-[var(--text-tertiary)]">{note}</p>}
    </section>
  )
}

/** Where the limits came from, and which the container does not set. */
function limitsSentence (m: Instance['metrics'], cpuHost: boolean, memHost: boolean): string {
  if (!m) return ''
  if (!m.cgroup) return 'No container limits found, so the shares are of the host.'
  const unset = [cpuHost && 'CPU quota', memHost && 'memory limit'].filter(Boolean)
  if (unset.length === 0) return `Limits from the container (cgroup v${m.cgroup}).`
  return `The container (cgroup v${m.cgroup}) sets no ${unset.join(' or ')}, so ${unset.length === 2 ? 'both are shares' : `that ${unset[0] === 'CPU quota' ? 'CPU' : 'memory'} is a share`} of the host.`
}

/** Which resources an overlay judges to be at their limit, to draw in amber. */
export type ResourcesHot = Partial<Record<'pool' | 'cpu' | 'memory' | 'loop', boolean>>

/**
 * Pool, CPU, memory and event loop at the last heartbeat, against the limits core read. A share with
 * no container limit is of the host, and its bar is striped.
 */
export function ResourceTiles ({ instance: i, hot = {} }: { instance: Instance, hot?: ResourcesHot }) {
  const m = i.metrics
  // Throttling is read off the quota, so a CPU figure with no throttling figure has no quota.
  const cpuHost = m?.cpu != null && m.cpuThrottled == null
  const memHost = m?.memoryUsed == null
  const used = m ? m.memoryUsed ?? m.rss : null
  const heap = m?.heapUsed != null && m.heapLimit ? m.heapUsed / m.heapLimit : null
  const cores = (n: number) => `${formatCores(n)} ${n === 1 ? 'core' : 'cores'}`

  return (
    <div className="grid gap-1.5">
      <div className="grid gap-3 @md:grid-cols-2 @5xl:grid-cols-4">
        <ResourceTile
          label="Pool"
          value={i.poolMax == null ? <Muted>—</Muted> : i.poolTotal ?? 0}
          of={i.poolMax == null ? 'db adapter, not counted' : `of ${i.poolMax} · ${i.poolIdle ?? 0} idle${i.poolWaiting ? ` · ${i.poolWaiting} waiting` : ''}`}
          share={i.poolMax ? (i.poolTotal ?? 0) / i.poolMax : null}
          hot={hot.pool}
        />
        <ResourceTile
          label="CPU"
          value={m?.cpu == null ? <Muted>—</Muted> : formatCores(m.cpu)}
          of={m ? (cpuHost ? `no quota, host has ${cores(m.cpuLimit)}` : `of a ${formatCores(m.cpuLimit)}-core quota`) : undefined}
          share={m?.cpu == null ? null : m.cpu / m.cpuLimit}
          hot={hot.cpu}
          host={cpuHost}
          note={m?.cpuThrottled != null ? `throttled in ${Math.round(m.cpuThrottled * 100)}% of periods` : undefined}
        />
        <ResourceTile
          label="Memory"
          value={used != null ? formatBytes(used) : <Muted>—</Muted>}
          of={m ? (memHost ? `resident, host has ${formatBytes(m.memoryLimit)}` : `of a ${formatBytes(m.memoryLimit)} limit`) : undefined}
          share={m && used != null ? used / m.memoryLimit : null}
          hot={hot.memory}
          host={memHost}
          note={m ? <>{memHost ? 'no container limit' : 'working set'}{heap != null && ` · heap ${formatBytes(m.heapUsed!)} of ${formatBytes(m.heapLimit!)}`}</> : undefined}
        />
        <ResourceTile
          label="Event loop"
          value={m?.loopDelay == null ? <Muted>—</Muted> : formatMs(m.loopDelay)}
          of={m?.loopDelay == null ? undefined : 'p99'}
          hot={hot.loop}
          note={m?.loopDelay == null ? undefined : `max ${formatMs(m.loopDelayMax ?? m.loopDelay)}${m.loopUtilization == null ? '' : ` · busy ${Math.round(m.loopUtilization * 100)}%`}`}
        />
      </div>
      <p className="text-xs text-[var(--text-tertiary)]">
        {i.live ? 'From the last heartbeat.' : 'At the last heartbeat.'}{' '}
        {limitsSentence(m, cpuHost, memHost)}{' '}
        No history of these is kept.
      </p>
    </div>
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

/** One registered instance: its resources, what it works and its options, with its process beside them. */
export function InstancePage ({ data }: { data: InstancePageData }) {
  const { instance, checkedOn, connections } = data

  return (
    <div className="grid gap-4">
      <InstancePageHeader instance={instance} checkedOn={checkedOn} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="@container grid min-w-0 gap-4">
          <ResourceTiles instance={instance} />
          <WorkersCard instance={instance} checkedOn={checkedOn} />
          <OptionsCard instance={instance} />
        </div>
        <aside aria-label="Process" className="grid min-w-0 gap-4">
          <ProcessCard instance={instance} checkedOn={checkedOn} connections={connections} />
        </aside>
      </div>
    </div>
  )
}
