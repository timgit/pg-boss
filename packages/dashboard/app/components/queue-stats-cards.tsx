import { DbLink } from '~/components/db-link'
import { cn } from '~/lib/utils'

interface QueueStatsCardsProps {
  totalQueues: number
  problemQueues: number
}

export function QueueStatsCards ({ totalQueues, problemQueues }: QueueStatsCardsProps) {
  return (
    <DbLink
      to="/queues"
      className={cn(
        'block overflow-hidden rounded-xl border shadow-sm transition-all',
        'bg-white border-gray-200 hover:shadow-md hover:border-gray-300',
        'dark:bg-gray-900 dark:border-gray-800 dark:hover:border-gray-700'
      )}
    >
      <div className="p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <div className="flex-shrink-0 rounded-lg p-3 bg-gray-50 dark:bg-gray-800">
              <QueueIcon className="h-6 w-6 text-gray-600 dark:text-gray-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Queues
              </p>
              <p className="text-2xl font-semibold text-gray-600 dark:text-gray-400">
                {totalQueues.toLocaleString()}
              </p>
            </div>
          </div>

          {problemQueues > 0 && (
            <div className="flex items-center">
              <div className="flex-shrink-0 rounded-lg p-3 bg-gray-50 dark:bg-gray-800">
                <WarningIcon className="h-6 w-6 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="ml-4 text-right">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Needing Attention
                </p>
                <p className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
                  {problemQueues.toLocaleString()}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </DbLink>
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

