import type { ReactNode } from 'react'
import type { QueueStats } from '~/lib/types'
import { Count } from '~/components/ui/count'
import { cn } from '~/lib/utils'

/** Which cell: the `QueueStats` figure it leads with. */
export type StatKey = 'totalReady' | 'totalActive' | 'totalFailed' | 'totalJobs'

interface StatsCardsProps {
  stats: QueueStats
  /** A line under a cell, by the figure it leads with, for an overlay's figure the stats do not have. */
  footers?: Partial<Record<StatKey, ReactNode>>
}

const n = (value: number) => <b className="font-semibold text-[var(--text-primary)]"><Count value={value} /></b>

/**
 * The overview's figures in one card: ready, active, failed and total. Queued and deferred are not
 * cells of their own, since queued is ready, deferred and blocked together; they are Ready's lines.
 */
export function StatsCards ({ stats, footers = {} }: StatsCardsProps) {
  const blocked = Math.max(0, stats.totalQueued - stats.totalReady - stats.totalDeferred)
  // Total counts the completed and canceled jobs still kept as well as the live ones.
  const finished = Math.max(0, stats.totalJobs - stats.totalQueued - stats.totalActive - stats.totalFailed)

  const cells: Array<{ key: StatKey, label: string, primary?: boolean, lines: ReactNode[] }> = [
    {
      key: 'totalReady',
      label: 'Ready',
      primary: true,
      lines: [
        <>of {n(stats.totalQueued)} queued</>,
        <>{stats.totalDeferred > 0 ? <><Count value={stats.totalDeferred} /> deferred for later</> : 'none deferred'}{blocked > 0 && <> · <Count value={blocked} /> blocked</>}</>,
      ],
    },
    { key: 'totalActive', label: 'Active', primary: true, lines: ['processing now'] },
    { key: 'totalFailed', label: 'Failed', lines: ['recent failures'] },
    {
      key: 'totalJobs',
      label: 'Total Jobs',
      lines: ['stored across queues', ...(finished > 0 ? [<><Count value={finished} /> completed or canceled</>] : [])],
    },
  ]

  return (
    // Four across once the card itself is wide enough, two by two before, whatever column it sits
    // in. The rules between cells are the card's border showing through a 1px gap, so they stay
    // right either way.
    <div className="@container">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-[var(--border-default)] bg-[var(--border-default)] shadow-sm @xl:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.key} className="flex min-w-0 flex-col gap-1.5 bg-[var(--surface-card)] px-4 py-4">
            <span className="pgb-eyebrow">{cell.label}</span>
            <span
              className={cn(
                'pgb-num mt-1 text-3xl font-medium leading-none tracking-tight',
                cell.primary ? 'text-primary-600 dark:text-primary-400' : 'text-gray-900 dark:text-gray-100'
              )}
            >
              <Count value={stats[cell.key]} />
            </span>
            <span className="mt-1 text-xs text-[var(--text-secondary)]">{cell.lines[0]}</span>
            {cell.lines.slice(1).map((line, k) => (
              <span key={k} className="text-xs text-[var(--text-tertiary)]">{line}</span>
            ))}
            {footers[cell.key] && <span className="text-xs text-[var(--text-tertiary)]">{footers[cell.key]}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
