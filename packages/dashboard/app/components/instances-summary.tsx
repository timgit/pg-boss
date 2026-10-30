import { Fragment, type ReactNode } from 'react'
import type { Connections, Instance } from '~/lib/types'
import { endedOn, instanceName, instanceStatus, liveVersions, type InstanceSummary } from '~/lib/instances'
import { DbLink } from '~/components/db-link'
import { cn } from '~/lib/utils'

/**
 * The instances in summary: the tiles above the `/instances` list, and the overview's Instances card.
 * Each takes an `aside` or children for what an overlay judges on top, such as a health badge or what
 * needs attention, so the free and Pro pages share one layout.
 */

const DAY_MS = 86_400_000

/** A card with a title and a link beside it, as the overview's side column draws them. */
export function Panel ({ label, title, link, children }: { label: string, title: ReactNode, link?: { to: string, text: string }, children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-[var(--border-default)] p-4 shadow-sm"
      style={{ background: 'var(--surface-card-grad)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
        {link && <DbLink to={link.to} className="text-sm font-medium text-[var(--primary-600)] dark:text-[var(--primary-400)] hover:underline">{link.text}</DbLink>}
      </div>
      {children}
    </section>
  )
}

/** One of the tiles above the instance list: a label, something beside it, a figure, and lines under it. */
export function SummaryTile ({ label, aside, value, children }: { label: string, aside?: ReactNode, value?: ReactNode, children?: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-[var(--border-default)] px-4 py-3 shadow-sm"
      style={{ background: 'var(--surface-card-grad)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="pgb-eyebrow">{label}</span>
        {aside}
      </div>
      {value !== undefined && <div className="pgb-num text-[24px] font-semibold leading-tight tracking-[-0.02em] text-[var(--text-primary)]">{value}</div>}
      {children}
    </section>
  )
}

const Small = ({ children }: { children: ReactNode }) => (
  <small className="ml-1 text-[13px] font-medium tracking-normal text-[var(--text-tertiary)]">{children}</small>
)

const B = ({ children }: { children: ReactNode }) => <b className="font-medium text-[var(--text-secondary)]">{children}</b>

const Note = ({ children }: { children: ReactNode }) => <p className="text-xs text-[var(--text-tertiary)]">{children}</p>

export const checkedLabel = (checkedOn: Date) => `Checked ${checkedOn.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`

/** How many are live and on how many hosts, and what went quiet or stopped in the last day. `children` go under a rule. */
export function LiveTile ({ instances, checkedOn, children }: { instances: Instance[], checkedOn: Date, children?: ReactNode }) {
  const live = instances.filter((i) => i.live)
  const hosts = new Set(live.map((i) => i.host)).size
  const day = checkedOn.getTime() - DAY_MS
  const quiet = instances.filter((i) => instanceStatus(i) === 'quiet' && (endedOn(i)?.getTime() ?? 0) >= day).length
  const stopped = instances.filter((i) => i.stoppedOn && new Date(i.stoppedOn).getTime() >= day).length

  return (
    <SummaryTile
      label="Live"
      aside={<span className="text-xs text-[var(--text-tertiary)]">{checkedLabel(checkedOn)}</span>}
      value={<>{live.length}<Small>on {hosts} {hosts === 1 ? 'host' : 'hosts'}</Small></>}
    >
      <Note><B>{quiet}</B> went quiet · <B>{stopped}</B> stopped cleanly in the last 24h</Note>
      {children && (
        <>
          <hr className="my-1 border-[var(--border-subtle)]" />
          {children}
        </>
      )}
    </SummaryTile>
  )
}

function Key ({ color, children }: { color: string, children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
      {children}
    </span>
  )
}

/** The server's connections in use against `max_connections`, pg-boss's apart from every other app's. */
export function ConnectionsTile ({ connections }: { connections: Connections | null }) {
  if (!connections) {
    return (
      <SummaryTile label="Database connections" value={<span className="text-[var(--text-tertiary)]">—</span>}>
        <Note>This login cannot read max_connections or pg_stat_activity here.</Note>
      </SummaryTile>
    )
  }
  const boss = Object.values(connections.byApp).reduce((a, b) => a + b.total, 0)
  const other = Math.max(0, connections.used - boss)
  const width = (n: number) => `${Math.min(100, (n / Math.max(1, connections.max)) * 100)}%`
  return (
    <SummaryTile label="Database connections" value={<>{connections.used}<Small>of {connections.max}</Small></>}>
      <div className="flex h-1.5 overflow-hidden rounded bg-[var(--surface-sunken)]" role="img" aria-label={`${boss} pg-boss, ${other} other apps, of ${connections.max}`}>
        <span style={{ width: width(boss), background: 'var(--conn-pgboss)' }} />
        <span style={{ width: width(other), background: 'var(--conn-other)' }} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-[var(--text-tertiary)]">
        <Key color="var(--conn-pgboss)">pg-boss {boss}</Key>
        <Key color="var(--conn-other)">other apps {other}</Key>
      </div>
    </SummaryTile>
  )
}

/** The pg-boss versions live, and which live instances have `supervise` and `schedule` on. */
export function VersionsOptionsTile ({ instances, aside }: { instances: Instance[], aside?: ReactNode }) {
  const versions = liveVersions(instances)
  const live = instances.filter((i) => i.live)
  const names = (list: Instance[]) => {
    const all = [...new Set(list.map((i) => instanceName(i.name)))]
    return <><B>{all.slice(0, 2).join(', ')}</B>{all.length > 2 && ` +${all.length - 2}`}</>
  }
  const on = (option: 'supervise' | 'schedule') => {
    const list = live.filter((i) => i[option])
    return list.length === 0
      ? <span className={cn(option === 'supervise' && 'text-[var(--state-retry-fg)]')}>on no live instance</span>
      : <>on {names(list)}</>
  }
  const row = 'contents [&>dt]:font-mono [&>dt]:text-xs [&>dt]:text-[var(--text-tertiary)] [&>dd]:min-w-0 [&>dd]:text-[var(--text-secondary)]'

  return (
    <SummaryTile label="Versions and options" aside={aside}>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-[12.5px]">
        <div className={row}>
          <dt>version</dt>
          <dd>
            {versions.length === 0
              ? 'nothing is live'
              : versions.map((v, k) => (
                <Fragment key={v.version}>
                  {k > 0 && ' · '}
                  <span className={cn(k > 0 && 'text-[var(--state-retry-fg)]')}><b className={cn('font-medium', k === 0 && 'text-[var(--text-secondary)]')}>{v.version}</b> on {v.count}</span>
                </Fragment>
              ))}
          </dd>
        </div>
        <div className={row}><dt>supervise</dt><dd>{on('supervise')}</dd></div>
        <div className={row}><dt>schedule</dt><dd>{on('schedule')}</dd></div>
      </dl>
    </SummaryTile>
  )
}

/** The three tiles above the instance list. An overlay passes what it judges on top through `live` and `versionsAside`. */
export function InstanceSummaryTiles ({ instances, checkedOn, connections, live, versionsAside }: {
  instances: Instance[]
  checkedOn: Date
  connections: Connections | null
  live?: ReactNode
  versionsAside?: ReactNode
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1.35fr_1fr_1.2fr]">
      <LiveTile instances={instances} checkedOn={checkedOn}>{live}</LiveTile>
      <ConnectionsTile connections={connections} />
      <VersionsOptionsTile instances={instances} aside={versionsAside} />
    </div>
  )
}

/** The overview's Instances card: live and quiet, pg-boss's share of the connections, and the hosts and versions. */
export function InstancesCard ({ summary, aside }: { summary: InstanceSummary | null, aside?: ReactNode }) {
  if (!summary) {
    return (
      <Panel label="Instances" title="Instances" link={{ to: '/instances', text: 'Open' }}>
        <p className="text-sm text-[var(--text-tertiary)]">Instances register from pg-boss 12.36.</p>
      </Panel>
    )
  }
  const c = summary.connections
  const width = (n: number) => `${c ? Math.min(100, (n / Math.max(1, c.max)) * 100) : 0}%`
  return (
    <Panel label="Instances" title="Instances" link={{ to: '/instances', text: 'Open' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="pgb-num text-2xl font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          {summary.live}<small className="ml-1 text-[13px] font-medium tracking-normal text-[var(--text-tertiary)]">live</small>
          {summary.quiet > 0 && <> <span className="text-[var(--state-retry-fg)]">{summary.quiet}</span><small className="ml-1 text-[13px] font-medium tracking-normal text-[var(--text-tertiary)]">quiet</small></>}
        </span>
        {aside}
      </div>
      {c && (
        <>
          <div className="flex h-2 overflow-hidden rounded bg-[var(--surface-sunken)]" role="img" aria-label={`${c.boss} pg-boss connections, ${c.other} other, of ${c.max}`}>
            <span style={{ width: width(c.boss), background: 'var(--conn-pgboss)' }} />
            <span style={{ width: width(c.other), background: 'var(--conn-other)' }} />
          </div>
          <p className="text-[11.5px] text-[var(--text-secondary)]">
            pg-boss {c.boss} · other apps {c.other} · free {Math.max(0, c.max - c.boss - c.other)} of {c.max}
          </p>
        </>
      )}
      <p className="text-xs text-[var(--text-tertiary)]">On {summary.hosts} {summary.hosts === 1 ? 'host' : 'hosts'}{summary.versions.length > 0 ? `, ${summary.versions.join(', ')}` : ''}.</p>
    </Panel>
  )
}
