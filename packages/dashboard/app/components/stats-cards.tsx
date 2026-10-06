import type { ReactNode } from 'react'
import type { QueueStats } from '~/lib/types'
import { StatCard } from '~/components/ui/stat-card'
import { Count } from '~/components/ui/count'

/** Which card: the `QueueStats` figure it shows. */
export type StatKey = 'totalQueued' | 'totalDeferred' | 'totalReady' | 'totalActive' | 'totalFailed' | 'totalJobs'

interface StatsCardsProps {
  stats: QueueStats
  /** A line under a card, by the figure it sits under, for an overlay's figure the stats do not have. */
  footers?: Partial<Record<StatKey, ReactNode>>
}

const statCards = [
  { name: 'Queued Jobs', key: 'totalQueued' as const, hint: 'incl. deferred', accent: 'neutral' as const },
  { name: 'Deferred', key: 'totalDeferred' as const, hint: 'scheduled for later', accent: 'neutral' as const },
  { name: 'Ready', key: 'totalReady' as const, hint: 'ready to process', accent: 'primary' as const },
  { name: 'Active', key: 'totalActive' as const, hint: 'processing now', accent: 'primary' as const },
  { name: 'Failed', key: 'totalFailed' as const, hint: 'recent failures', accent: 'neutral' as const },
  { name: 'Total Jobs', key: 'totalJobs' as const, hint: 'current storage across queues', accent: 'neutral' as const },
]

export function StatsCards ({ stats, footers }: StatsCardsProps) {
  return (
    <>
      {statCards.map((stat) => (
        <StatCard
          key={stat.key}
          label={stat.name}
          value={<Count value={stats[stat.key]} />}
          hint={stat.hint}
          accent={stat.accent}
          footer={footers?.[stat.key]}
        />
      ))}
    </>
  )
}
