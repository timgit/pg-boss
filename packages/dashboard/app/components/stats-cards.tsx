import type { ReactNode } from 'react'
import type { QueueStats } from '~/lib/types'
import { Count } from '~/components/ui/count'
import { DbLink } from '~/components/db-link'
import { cn } from '~/lib/utils'

/** Which cell: the `QueueStats` figure it leads with. */
export type StatKey = 'totalReady' | 'totalActive' | 'totalFailed' | 'totalJobs'

interface StatsCardsProps {
  stats: QueueStats
  /** A line under a cell, by the figure it leads with, for an overlay's figure the stats do not have. */
  footers?: Partial<Record<StatKey, ReactNode>>
}

/** One cell of a `CountsCard`: a figure, the lines under it, and where it leads. */
export interface CountCell {
  key: string
  label: string
  value: number
  /** Drawn in the primary color, for the figures that move. */
  primary?: boolean
  /** Beside the figure, such as a sparkline. */
  aside?: ReactNode
  /** The first in the secondary color, the rest quieter. */
  lines: ReactNode[]
  /** Makes the whole cell a link. */
  to?: string
}

/** A figure inside a cell's line, in the primary text color unless `className` says otherwise. */
export const strong = (value: number, className?: string) => (
  <b className={cn('font-semibold text-[var(--text-primary)]', className)}><Count value={value} /></b>
)

/**
 * Counts in one card, a cell each: four across once the card itself is wide enough, two by two
 * before, whatever column it sits in.
 */
export function CountsCard ({ cells, label }: { cells: CountCell[], label?: string }) {
  return (
    // The rules between cells are the card's border showing through a 1px gap, so they stay right
    // however the cells wrap.
    <section aria-label={label} className="@container">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-[var(--border-default)] bg-[var(--border-default)] shadow-sm @xl:grid-cols-4">
        {cells.map((cell) => {
          const body = (
            <>
              <span className="pgb-eyebrow">{cell.label}</span>
              <span className="mt-1 flex items-end justify-between gap-3">
                <span
                  className={cn(
                    'pgb-num text-3xl font-medium leading-none tracking-tight',
                    cell.primary ? 'text-primary-600 dark:text-primary-400' : 'text-gray-900 dark:text-gray-100'
                  )}
                >
                  <Count value={cell.value} />
                </span>
                {cell.aside}
              </span>
              <span className="mt-1 text-xs text-[var(--text-secondary)]">{cell.lines[0]}</span>
              {cell.lines.slice(1).map((line, k) => (
                <span key={k} className="text-xs text-[var(--text-tertiary)]">{line}</span>
              ))}
            </>
          )
          const className = 'flex min-w-0 flex-col gap-1.5 bg-[var(--surface-card)] px-4 py-4'
          return cell.to
            ? <DbLink key={cell.key} to={cell.to} className={cn(className, 'transition-colors hover:bg-[var(--surface-hover)]')}>{body}</DbLink>
            : <div key={cell.key} className={className}>{body}</div>
        })}
      </div>
    </section>
  )
}

/**
 * The overview's figures in one card: ready, active, failed and total. Queued and deferred are not
 * cells of their own, since queued is ready, deferred and blocked together; they are Ready's lines.
 */
export function StatsCards ({ stats, footers = {} }: StatsCardsProps) {
  const blocked = Math.max(0, stats.totalQueued - stats.totalReady - stats.totalDeferred)
  // Total counts the completed and canceled jobs still kept as well as the live ones.
  const finished = Math.max(0, stats.totalJobs - stats.totalQueued - stats.totalActive - stats.totalFailed)
  const footer = (key: StatKey) => (footers[key] ? [footers[key]] : [])

  return (
    <CountsCard
      cells={[
        {
          key: 'totalReady',
          label: 'Ready',
          value: stats.totalReady,
          primary: true,
          lines: [
            <>of {strong(stats.totalQueued)} queued</>,
            <>{stats.totalDeferred > 0 ? <><Count value={stats.totalDeferred} /> deferred for later</> : 'none deferred'}{blocked > 0 && <> · <Count value={blocked} /> blocked</>}</>,
            ...footer('totalReady'),
          ],
        },
        { key: 'totalActive', label: 'Active', value: stats.totalActive, primary: true, lines: ['processing now', ...footer('totalActive')] },
        { key: 'totalFailed', label: 'Failed', value: stats.totalFailed, lines: ['recent failures', ...footer('totalFailed')] },
        {
          key: 'totalJobs',
          label: 'Total Jobs',
          value: stats.totalJobs,
          lines: ['stored across queues', ...(finished > 0 ? [<><Count value={finished} /> completed or canceled</>] : []), ...footer('totalJobs')],
        },
      ]}
    />
  )
}
