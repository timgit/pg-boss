import type { QueueStats } from '~/lib/types'
import { StatCard } from '~/components/ui/stat-card'

interface StatsCardsProps {
  stats: QueueStats
}

const statCards = [
  { name: 'Queued Jobs', key: 'totalQueued' as const, hint: 'waiting to process', accent: 'neutral' as const },
  { name: 'Active', key: 'totalActive' as const, hint: 'processing now', accent: 'primary' as const },
  { name: 'Deferred', key: 'totalDeferred' as const, hint: 'scheduled for later', accent: 'neutral' as const },
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
