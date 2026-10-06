import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRevalidator } from 'react-router'
import { Search } from 'lucide-react'
import type { Instance } from '~/lib/types'
import {
  byName,
  formatAgo,
  formatSpan,
  instanceName,
  instanceRoles,
  listInstances,
  matchesInstance,
  type InstanceBucket,
  type InstanceStatus,
  type ListedInstance,
} from '~/lib/instances'
import { Badge } from '~/components/ui/badge'
import { Card } from '~/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { DbLink } from '~/components/db-link'
import { cn } from '~/lib/utils'

// Heartbeats land every 30 seconds by default, so a registry read once goes stale within a minute.
const REFRESH_MS = 15_000

/**
 * Re-reads the page's loader while the tab is visible, and the moment it is shown again. The
 * revalidator is read through a ref so the interval is not restarted by the re-render each refresh causes.
 */
export function useRegistryRefresh (enabled: boolean) {
  const revalidator = useRevalidator()
  const latest = useRef(revalidator)
  latest.current = revalidator

  useEffect(() => {
    if (!enabled) return
    const refresh = () => {
      if (document.visibilityState === 'visible' && latest.current.state === 'idle') latest.current.revalidate()
    }
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [enabled])
}

export const instancePath = (id: string) => `/instances/${encodeURIComponent(id)}`

const BUCKETS: Array<[InstanceBucket, string]> = [['live', 'Live'], ['quiet', 'Quiet'], ['stopped', 'Stopped']]

export function StatusBadge ({ status }: { status: InstanceStatus }) {
  if (status === 'live') return <Badge variant="success" size="sm" dot>Live</Badge>
  if (status === 'quiet') return <Badge variant="warning" size="sm" dot>Quiet</Badge>
  return <Badge variant="gray" size="sm" dot>Stopped</Badge>
}

/** Under the status badge: how long a live row has been up and its last beat, or when an ended one ended. */
export function statusLine (instance: Instance, status: InstanceStatus, checkedOn: Date): string {
  if (status === 'live') return `up ${formatSpan(checkedOn.getTime() - new Date(instance.startedOn).getTime())} · beat ${formatAgo(instance.heartbeatOn, checkedOn)}`
  if (status === 'quiet') return `last beat ${formatAgo(instance.heartbeatOn, checkedOn)}`
  return `stopped ${formatAgo(instance.stoppedOn!, checkedOn)}`
}

/** The queues an instance works, the first two linked, or "sends only". */
export function WorksCell ({ instance }: { instance: Instance }) {
  const queues = [...new Set(instance.workers.map((w) => w.queue))]
  if (queues.length === 0) return <span className="text-[var(--text-tertiary)]">sends only</span>
  return (
    <span title={queues.join(', ')}>
      {queues.slice(0, 2).map((q, k) => (
        <Fragment key={q}>
          {k > 0 && ', '}
          <DbLink to={`/queues/${encodeURIComponent(q)}`} className="hover:text-[var(--text-primary)] hover:underline">{q}</DbLink>
        </Fragment>
      ))}
      {queues.length > 2 && <span className="text-[var(--text-tertiary)]"> +{queues.length - 2}</span>}
    </span>
  )
}

/** The name, linked to the row's page, with its short id, host and pid under it. */
export function InstanceName ({ instance: i }: { instance: Instance }) {
  return (
    <>
      <DbLink
        to={instancePath(i.id)}
        className={cn('block font-medium hover:underline', i.name ? 'text-[var(--text-primary)]' : 'font-normal italic text-[var(--text-secondary)]')}
      >
        {instanceName(i.name)}
      </DbLink>
      <span className="block text-[11.5px] text-[var(--text-tertiary)]">
        <span className="font-mono">{i.id.slice(0, 8)}</span> · {i.host} · pid {i.pid}
      </span>
    </>
  )
}

/** The status buttons, the Recent toggle and the search box above an instance list. */
export interface InstanceFilters {
  needle: string
  buckets: ReadonlySet<InstanceBucket>
  recentOnly: boolean
}

export function useInstanceFilters () {
  const [needle, setNeedle] = useState('')
  const [buckets, setBuckets] = useState<ReadonlySet<InstanceBucket>>(new Set(['live', 'quiet']))
  const [recentOnly, setRecentOnly] = useState(false)
  const toggleBucket = (bucket: InstanceBucket) => setBuckets((previous) => {
    const next = new Set(previous)
    if (!next.delete(bucket)) next.add(bucket)
    return next
  })
  return { filters: { needle, buckets, recentOnly }, setNeedle, toggleBucket, setRecentOnly }
}

/** Whether the filters list a row. */
export function passesFilters (l: ListedInstance, filters: InstanceFilters): boolean {
  return filters.buckets.has(l.bucket) && (!filters.recentOnly || l.recent) && matchesInstance(l.instance, filters.needle.trim())
}

const chip = (on: boolean) => cn(
  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
  on
    ? 'border-[var(--border-strong)] bg-[var(--surface-card)] text-[var(--text-primary)]'
    : 'border-[var(--border-subtle)] text-[var(--text-tertiary)]'
)

export function InstanceFilterBar ({ listed, state, end }: {
  listed: ListedInstance[]
  state: ReturnType<typeof useInstanceFilters>
  /** At the right of the bar, such as an overlay's sort. */
  end?: ReactNode
}) {
  const { filters, setNeedle, toggleBucket, setRecentOnly } = state
  const counts = { live: 0, quiet: 0, stopped: 0 }
  for (const l of listed) counts[l.bucket]++
  const recent = listed.filter((l) => l.recent).length

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-tertiary)]">
        <div className="relative">
          <input
            type="search"
            aria-label="Filter instances"
            placeholder="Filter by name, host, id or queue"
            value={filters.needle}
            onChange={(e) => setNeedle(e.target.value)}
            className={cn(
              'h-[34px] w-64 max-w-full rounded-lg border py-1.5 pl-8 pr-3 text-sm shadow-sm',
              'border-[var(--border-strong)] bg-[var(--surface-card)] text-[var(--text-primary)] placeholder-[var(--text-tertiary)]',
              'focus:border-[var(--border-focus)] focus:shadow-[var(--shadow-focus)] focus:outline-none'
            )}
          />
          <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
        </div>
        <div role="group" aria-label="Status" className="flex flex-wrap gap-1.5">
          {BUCKETS.map(([bucket, label]) => (
            <button key={bucket} type="button" aria-pressed={filters.buckets.has(bucket)} onClick={() => toggleBucket(bucket)} className={chip(filters.buckets.has(bucket))}>
              {label} <b className="pgb-num font-medium">{counts[bucket]}</b>
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={filters.recentOnly}
          title="Started, stopped or went quiet in the last 24 hours"
          onClick={() => setRecentOnly(!filters.recentOnly)}
          className={chip(filters.recentOnly)}
        >
          Recent <b className="pgb-num font-medium">{recent}</b>
        </button>
      </div>
      {end}
    </div>
  )
}

/** What the list says when no row is shown. */
export function emptyMessage (total: number, filters: InstanceFilters): string {
  if (total === 0) return 'No instance has registered in this database yet.'
  if (filters.buckets.size === 0) return 'Turn on a status above.'
  return 'No instances match. Clear the filter or turn on another status.'
}

interface InstancesTableProps {
  instances: Instance[]
  checkedOn: Date
}

/**
 * Every registered row, live and quiet by default, with filters for the stopped and the recent.
 * Each row is one start of one process and opens its own page; restarts are separate rows.
 */
export function InstancesTable ({ instances, checkedOn }: InstancesTableProps) {
  const state = useInstanceFilters()
  const listed = useMemo(() => listInstances(instances, checkedOn), [instances, checkedOn])
  const shown = listed.filter((l) => passesFilters(l, state.filters)).sort(byName)

  return (
    <section aria-label="Instance list" className="grid gap-3">
      <InstanceFilterBar listed={listed} state={state} end={<span className="text-xs text-[var(--text-tertiary)]">By name</span>} />

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Instance</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Works</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <tr>
                <TableCell colSpan={5} className="py-8 text-center text-[var(--text-tertiary)]">
                  {emptyMessage(instances.length, state.filters)}
                </TableCell>
              </tr>
            )}
            {shown.map(({ instance: i, status }) => {
              const roles = instanceRoles(i)
              return (
                <TableRow key={i.id} to={instancePath(i.id)}>
                  <TableCell className="align-top"><InstanceName instance={i} /></TableCell>
                  <TableCell className="align-top">
                    <StatusBadge status={status} />
                    <span className="pgb-num mt-1 block text-[11.5px] text-[var(--text-tertiary)]">{statusLine(i, status, checkedOn)}</span>
                  </TableCell>
                  <TableCell className="pgb-num align-top">{i.version}</TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap gap-1">
                      {roles.length
                        ? roles.map((r) => <Badge key={r} size="sm">{r}</Badge>)
                        : <span className="text-[var(--text-tertiary)]">{i.workers.length ? 'worker' : 'none'}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[26ch] whitespace-normal align-top"><WorksCell instance={i} /></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </section>
  )
}

/** Under the list: which instances register, and how long a row is kept. */
export function RegistryFootnote () {
  return (
    <p className="text-xs text-[var(--text-tertiary)]">
      Instances register from pg-boss 12.36. Older versions, and any started
      with <code className="font-mono">registerInstance: false</code>, connect without appearing here. Every start registers
      a new row with a new id. A row goes quiet after three missed heartbeats, and is deleted a week after its last one.
    </p>
  )
}

/** Shown instead of the list when the schema predates the registry. */
export function RegistryUnavailable () {
  return (
    <p role="status" className="text-sm text-[var(--text-secondary)]">
      This database's schema predates the instance registry. Instances appear here once it is
      migrated to 12.36 or later.
    </p>
  )
}
