import type { AggregateStats } from '~/lib/types'
import { cn } from '~/lib/utils'

interface StatsCardsProps {
  stats: AggregateStats
}

const statCards = [
  {
    name: 'Queued Jobs',
    key: 'totalQueued' as const,
    description: 'Jobs waiting to be processed',
    color: 'text-gray-600 dark:text-gray-400',
    bgColor: 'bg-gray-50 dark:bg-gray-800',
  },
  {
    name: 'Active Jobs',
    key: 'totalActive' as const,
    description: 'Jobs currently processing',
    color: 'text-gray-600 dark:text-gray-400',
    bgColor: 'bg-gray-50 dark:bg-gray-800',
  },
  {
    name: 'Deferred Jobs',
    key: 'totalDeferred' as const,
    description: 'Jobs scheduled for later',
    color: 'text-gray-600 dark:text-gray-400',
    bgColor: 'bg-gray-50 dark:bg-gray-800',
  },
  {
    name: 'Total Jobs',
    key: 'totalJobs' as const,
    description: 'All jobs across queues',
    color: 'text-gray-600 dark:text-gray-400',
    bgColor: 'bg-gray-50 dark:bg-gray-800',
  },
]

export function StatsCards ({ stats }: StatsCardsProps) {
  return (
    <>
      {statCards.map((stat) => (
        <div
          key={stat.key}
          className={cn(
            'overflow-hidden rounded-xl border shadow-sm',
            'bg-white border-gray-200',
            'dark:bg-gray-900 dark:border-gray-800'
          )}
        >
          <div className="p-5">
            <div className="flex items-center">
              <div className={cn('flex-shrink-0 rounded-lg p-3', stat.bgColor)}>
                <StatIcon className={cn('h-6 w-6', stat.color)} />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">
                  {stat.name}
                </p>
                <p className={cn('text-2xl font-semibold', stat.color)}>
                  {stats[stat.key].toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

function StatIcon ({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
      />
    </svg>
  )
}
