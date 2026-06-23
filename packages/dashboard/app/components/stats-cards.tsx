import type { QueueStats } from '~/lib/types'
import { StatCard } from '~/components/ui/stat-card'

interface StatsCardsProps {
  stats: QueueStats
}

const statCards = [
  { name: 'Queued Jobs', key: 'totalQueued' as const, hint: 'incl. deferred', accent: 'neutral' as const },
  { name: 'Deferred', key: 'totalDeferred' as const, hint: 'scheduled for later', accent: 'neutral' as const },
  { name: 'Ready', key: 'totalReady' as const, hint: 'ready to process', accent: 'primary' as const },
  { name: 'Active', key: 'totalActive' as const, hint: 'processing now', accent: 'primary' as const },
  { name: 'Failed', key: 'totalFailed' as const, hint: 'recent failures', accent: 'neutral' as const },
  { name: 'Total Jobs', key: 'totalJobs' as const, hint: 'all-time across queues', accent: 'neutral' as const },
]

export function StatsCards ({ stats }: StatsCardsProps) {
  return (
    <>
      {statCards.map((stat) => (
        <StatCard
          key={stat.key}
          label={stat.name}
          value={stats[stat.key].toLocaleString()}
          hint={stat.hint}
          accent={stat.accent}
        />
      ))}
    </>
  )
}
