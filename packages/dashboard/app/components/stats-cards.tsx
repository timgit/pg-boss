import type { AggregateStats } from "~/lib/types";

interface StatsCardsProps {
  stats: AggregateStats;
}

const statCards = [
  {
    name: "Total Queued",
    key: "totalQueued" as const,
    description: "Jobs waiting to be processed",
    color: "text-primary-600",
    bgColor: "bg-primary-50",
  },
  {
    name: "Active",
    key: "totalActive" as const,
    description: "Jobs currently processing",
    color: "text-success-600",
    bgColor: "bg-success-50",
  },
  {
    name: "Deferred",
    key: "totalDeferred" as const,
    description: "Jobs scheduled for later",
    color: "text-warning-600",
    bgColor: "bg-warning-50",
  },
  {
    name: "Total Jobs",
    key: "totalJobs" as const,
    description: "All jobs across queues",
    color: "text-gray-600",
    bgColor: "bg-gray-50",
  },
];

export function StatsCards({ stats }: StatsCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {statCards.map((stat) => (
        <div
          key={stat.key}
          className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm"
        >
          <div className="p-5">
            <div className="flex items-center">
              <div className={`flex-shrink-0 rounded-lg p-3 ${stat.bgColor}`}>
                <StatIcon className={`h-6 w-6 ${stat.color}`} />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-gray-500 truncate">
                  {stat.name}
                </p>
                <p className={`text-2xl font-semibold ${stat.color}`}>
                  {stats[stat.key].toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatIcon({ className }: { className?: string }) {
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
  );
}
