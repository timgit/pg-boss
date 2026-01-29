import { DbLink } from '~/components/db-link'
import { cn } from '~/lib/utils'

interface QueueStatsCardsProps {
  totalQueues: number
  problemQueues: number
  partitionedQueues: number
}

const statCards = [
  {
    name: 'Total Queues',
    key: 'totalQueues' as const,
    description: 'All registered queues',
    color: 'text-primary-600 dark:text-gray-400',
    bgColor: 'bg-primary-50 dark:bg-gray-800',
    icon: 'queue',
    filter: 'all',
  },
  {
    name: 'Needing Attention',
    key: 'problemQueues' as const,
    description: 'Queues with high backlog',
    color: 'text-warning-600 dark:text-warning-400',
    bgColor: 'bg-warning-50 dark:bg-warning-950',
    icon: 'warning',
    filter: 'problems',
  },
  {
    name: 'Partitioned',
    key: 'partitionedQueues' as const,
    description: 'Queues with partitioning enabled',
    color: 'text-success-600 dark:text-success-400',
    bgColor: 'bg-success-50 dark:bg-success-950',
    icon: 'partition',
    filter: 'partitioned',
  },
]

export function QueueStatsCards ({ totalQueues, problemQueues, partitionedQueues }: QueueStatsCardsProps) {
  const stats = {
    totalQueues,
    problemQueues,
    partitionedQueues,
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {statCards.map((stat) => (
        <DbLink
          key={stat.key}
          to={`/queues?filter=${stat.filter}`}
          className={cn(
            'block overflow-hidden rounded-xl border shadow-sm transition-all',
            'bg-white border-gray-200 hover:shadow-md hover:border-gray-300',
            'dark:bg-gray-900 dark:border-gray-800 dark:hover:border-gray-700'
          )}
        >
          <div className="p-5">
            <div className="flex items-center">
              <div className={cn('flex-shrink-0 rounded-lg p-3', stat.bgColor)}>
                {stat.icon === 'queue' && <QueueIcon className={cn('h-6 w-6', stat.color)} />}
                {stat.icon === 'warning' && <WarningIcon className={cn('h-6 w-6', stat.color)} />}
                {stat.icon === 'partition' && <PartitionIcon className={cn('h-6 w-6', stat.color)} />}
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
        </DbLink>
      ))}
    </div>
  )
}

function QueueIcon ({ className }: { className?: string }) {
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
        d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z"
      />
    </svg>
  )
}

function WarningIcon ({ className }: { className?: string }) {
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
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
      />
    </svg>
  )
}

function PartitionIcon ({ className }: { className?: string }) {
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
        d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v13.5c0 .621.504 1.125 1.125 1.125Z"
      />
    </svg>
  )
}
