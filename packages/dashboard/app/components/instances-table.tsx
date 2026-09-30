import { Fragment, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ChevronRight, Search } from 'lucide-react'
import overlay from '~pro'
import type { Instance } from '~/lib/types'
import type { InstanceAssessment } from '~/lib/pro-contract'
import {
  byName,
  formatAgo,
  formatSpan,
  listInstances,
  matchesInstance,
  type InstanceBucket,
  type ListedInstance,
} from '~/lib/instances'
import { Badge } from '~/components/ui/badge'
import { Card } from '~/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader } from '~/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { DbLink } from '~/components/db-link'
import { cn } from '~/lib/utils'

const NO_ASSESSMENTS: ReadonlyMap<string, InstanceAssessment> = new Map()
const noAssessments = (_instances: Instance[], _checkedOn: Date) => NO_ASSESSMENTS

// Fixed for the life of the build, so the list always calls the same hook.
const slot = overlay.slots.instancesList
const useAssessments = slot?.useAssessments ?? noAssessments
const extraColumns = slot?.columns ?? []
const Detail = slot?.Detail

const BUCKETS: Array<[InstanceBucket, string]> = [['live', 'Live'], ['quiet', 'Quiet'], ['stopped', 'Stopped']]

const SEVERITY_STRIPE = {
  critical: 'border-l-[var(--error-500)]',
  watch: 'border-l-[var(--warning-500)]',
}

const clock = (d: Date | string) => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

interface InstancesTableProps {
  instances: Instance[]
  checkedOn: Date
}

// Every registered instance, live and quiet by default, with a filter for the stopped ones. An
// overlay may add columns, a stripe and an order per row, and a detail that opens under it.
export function InstancesTable ({ instances, checkedOn }: InstancesTableProps) {
  const overlaySort = slot?.sortLabel ?? null
  const [filter, setFilter] = useState('')
  const [buckets, setBuckets] = useState<ReadonlySet<InstanceBucket>>(new Set(['live', 'quiet']))
  const [sort, setSort] = useState<'overlay' | 'name'>(overlaySort ? 'overlay' : 'name')
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set())
  // The open row is in the URL, so a detail can be linked to and an overlay can open one.
  const [params, setParams] = useSearchParams()
  const open = Detail ? params.get('instance') : null
  const setOpen = (id: string | null) => setParams((previous) => {
    const next = new URLSearchParams(previous)
    if (id) next.set('instance', id)
    else next.delete('instance')
    return next
  }, { replace: true, preventScrollReset: true })

  const assessments = useAssessments(instances, checkedOn)
  const listed = useMemo(() => listInstances(instances, checkedOn), [instances, checkedOn])

  const counts = { live: 0, quiet: 0, stopped: 0 }
  for (const l of listed) counts[l.bucket]++

  const rank = (l: ListedInstance) => assessments.get(l.instance.id)?.rank ?? Infinity
  const ordered = sort === 'overlay'
    ? [...listed].sort((a, b) => rank(a) - rank(b) || byName(a, b))
    : [...listed].sort(byName)

  // A folded row shows under its head when the head is listed and unfolded; otherwise it is listed
  // on its own, like any other row in its bucket.
  const needle = filter.trim()
  const shown = ordered.filter((l) => buckets.has(l.bucket) && matchesInstance(l.instance, needle))
  const shownIds = new Set(shown.map((l) => l.instance.id))
  const byId = new Map(listed.map((l) => [l.instance.id, l]))
  const rows: Array<{ listed: ListedInstance, folded: boolean }> = []
  for (const l of shown) {
    if (l.foldedUnder && shownIds.has(l.foldedUnder)) continue
    rows.push({ listed: l, folded: false })
    if (unfolded.has(l.instance.id)) {
      for (const e of l.earlier) rows.push({ listed: byId.get(e.id)!, folded: true })
    }
  }

  // Opened from outside the list: make sure the row is listed, then bring it into view.
  useEffect(() => {
    const target = open ? byId.get(open) : undefined
    if (!target) return
    if (!buckets.has(target.bucket)) setBuckets((b) => new Set([...b, target.bucket]))
    if (target.foldedUnder) setUnfolded((u) => new Set([...u, target.foldedUnder!]))
    if (!matchesInstance(target.instance, filter.trim())) setFilter('')
    document.querySelector(`[data-instance-row="${target.instance.id}"]`)?.scrollIntoView?.({ block: 'center' })
    // Only when the open row changes: the filters are the reader's to change afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = <T,>(set: ReadonlySet<T>, value: T) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const columnCount = 8 + extraColumns.length

  return (
    <section aria-label="Instance list" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-tertiary)]">
          <div className="relative">
            <input
              type="search"
              aria-label="Filter instances"
              placeholder="Filter by name, host or queue"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
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
              <button
                key={bucket}
                type="button"
                aria-pressed={buckets.has(bucket)}
                onClick={() => setBuckets(toggle(buckets, bucket))}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
                  buckets.has(bucket)
                    ? 'border-[var(--border-strong)] bg-[var(--surface-card)] text-[var(--text-primary)]'
                    : 'border-[var(--border-subtle)] text-[var(--text-tertiary)]'
                )}
              >
                {label} <b className="pgb-num font-medium">{counts[bucket]}</b>
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-[var(--text-tertiary)]">
          {overlaySort
            ? (
              <ToggleGroup
                aria-label="Sort instances"
                value={[sort]}
                onValueChange={(value) => { if (value[0]) setSort(value[0] as 'overlay' | 'name') }}
              >
                <ToggleGroupItem value="overlay">{overlaySort}</ToggleGroupItem>
                <ToggleGroupItem value="name">By name</ToggleGroupItem>
              </ToggleGroup>
              )
            : <span>By name</span>}
        </div>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Instance</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Works</TableHead>
              {extraColumns.map((c) => (
                <TableHead key={c.header} className={c.align === 'right' ? 'text-right' : undefined}>{c.header}</TableHead>
              ))}
              <TableHead className="text-right">Up for</TableHead>
              <TableHead className="text-right">Heartbeat</TableHead>
              <TableHead>Status</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <tr>
                <TableCell colSpan={columnCount} className="py-8 text-center text-[var(--text-tertiary)]">
                  {instances.length === 0
                    ? 'No instance has registered in this database yet.'
                    : buckets.size === 0 ? 'Turn on a status above.' : 'No instances match. Clear the filter or turn on another status.'}
                </TableCell>
              </tr>
            )}
            {rows.map(({ listed: l, folded }) => {
              const id = l.instance.id
              const isOpen = Detail !== undefined && open === id
              return (
                <Fragment key={id}>
                  <InstanceRow
                    listed={l}
                    folded={folded}
                    checkedOn={checkedOn}
                    assessment={assessments.get(id) ?? null}
                    open={isOpen}
                    onToggleOpen={Detail ? () => setOpen(isOpen ? null : id) : undefined}
                    unfolded={unfolded.has(id)}
                    onToggleFold={() => setUnfolded(toggle(unfolded, id))}
                  />
                  {isOpen && Detail && (
                    <tr id={`instance-${id}`} className="border-b border-[var(--border-subtle)] bg-[var(--surface-hover)]">
                      <td colSpan={columnCount} className="px-4 pb-4 pt-1">
                        <Detail instance={l.instance} checkedOn={checkedOn} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </section>
  )
}

interface InstanceRowProps {
  listed: ListedInstance
  folded: boolean
  checkedOn: Date
  assessment: InstanceAssessment | null
  open: boolean
  onToggleOpen?: () => void
  unfolded: boolean
  onToggleFold: () => void
}

function InstanceRow ({ listed, folded, checkedOn, assessment, open, onToggleOpen, unfolded, onToggleFold }: InstanceRowProps) {
  const { instance: i, status, replaced, earlier } = listed
  const severity = assessment?.severity
  const roles = [i.supervise && 'supervisor', i.schedule && 'scheduler', i.migrate && 'migrator'].filter((r): r is string => Boolean(r))
  const queues = [...new Set(i.workers.map((w) => w.queue))]
  const ended = i.stoppedOn ?? i.heartbeatOn

  const name = (
    <>
      <span className={cn('block font-medium', i.name ? 'text-[var(--text-primary)]' : 'font-normal italic text-[var(--text-tertiary)]')}>
        {i.name ?? 'unnamed'}
      </span>
      <span className="block font-mono text-[11.5px] text-[var(--text-tertiary)]">{i.id.slice(0, 8)}</span>
    </>
  )

  return (
    <tr data-instance-row={i.id} className={cn('border-b border-[var(--border-subtle)]', open && 'bg-[var(--surface-hover)]', folded && 'bg-[var(--surface-sunken)]')}>
      <TableCell className={cn('border-l-[3px] border-l-transparent align-top', severity && SEVERITY_STRIPE[severity], folded && 'pl-8')}>
        {onToggleOpen
          ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? `instance-${i.id}` : undefined}
              onClick={onToggleOpen}
              className="flex cursor-pointer items-start gap-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]"
            >
              <ChevronRight aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0 text-[var(--text-tertiary)] transition-transform', open && 'rotate-90')} />
              <span>{name}</span>
            </button>
            )
          : name}
      </TableCell>
      <TableCell className="align-top">
        <span className="block text-[var(--text-primary)]">{i.host}</span>
        <span className="block font-mono text-[11.5px] text-[var(--text-tertiary)]">pid {i.pid}</span>
      </TableCell>
      <TableCell className="pgb-num align-top">
        {assessment?.flagVersion && status !== 'stopped'
          ? <Badge variant="warning" size="sm">{i.version}</Badge>
          : i.version}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-wrap gap-1">
          {roles.length
            ? roles.map((r) => <Badge key={r} size="sm">{r}</Badge>)
            : <span className="text-[var(--text-tertiary)]">{queues.length ? 'worker' : 'none'}</span>}
        </div>
      </TableCell>
      <TableCell className="max-w-[26ch] whitespace-normal align-top">
        {queues.length
          ? (
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
          : <span className="text-[var(--text-tertiary)]">sends only</span>}
      </TableCell>
      {extraColumns.map(({ header, align, Cell }) => (
        <TableCell key={header} className={cn('align-top', align === 'right' && 'text-right')}>
          <Cell instance={i} checkedOn={checkedOn} />
        </TableCell>
      ))}
      <TableCell className="pgb-num text-right align-top">
        {status === 'live'
          ? formatSpan(checkedOn.getTime() - new Date(i.startedOn).getTime())
          : <span className="text-[var(--text-tertiary)]">{formatSpan(new Date(ended).getTime() - new Date(i.startedOn).getTime())}</span>}
      </TableCell>
      <TableCell className="pgb-num text-right align-top">
        {i.stoppedOn
          ? <span className="text-[var(--text-tertiary)]">stopped {formatAgo(i.stoppedOn, checkedOn)}</span>
          : <span className={cn(status === 'quiet' && 'font-medium text-[var(--error-600)]')}>{formatAgo(i.heartbeatOn, checkedOn)}</span>}
      </TableCell>
      <TableCell className="align-top">
        <StatusBadge status={status} />
        {earlier.length > 0 && !folded && (
          <button
            type="button"
            aria-expanded={unfolded}
            onClick={onToggleFold}
            className="mt-1 block cursor-pointer text-xs text-[var(--primary-600)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]"
          >
            {unfolded ? 'Hide' : 'Show'} {earlier.length} earlier quiet
          </button>
        )}
        {replaced && status === 'quiet' && <span className="mt-1 block text-xs text-[var(--text-tertiary)]">replaced by a newer start</span>}
        {i.crashRestarts > 0 && !folded && (
          <span className="mt-1 block text-xs text-[var(--text-tertiary)]">
            {i.crashRestarts} crash {i.crashRestarts === 1 ? 'restart' : 'restarts'}{i.crashRestartsSince ? ` since ${clock(i.crashRestartsSince)}` : ''}
          </span>
        )}
      </TableCell>
    </tr>
  )
}

function StatusBadge ({ status }: { status: ListedInstance['status'] }) {
  if (status === 'live') return <Badge variant="success" size="sm" dot>Live</Badge>
  if (status === 'quiet') return <Badge variant="warning" size="sm" dot>Quiet</Badge>
  return <Badge variant="gray" size="sm" dot>Stopped</Badge>
}
