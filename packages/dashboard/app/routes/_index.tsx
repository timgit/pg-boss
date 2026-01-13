import { Link } from "react-router";
import type { Route } from "./+types/_index";
import {
  getQueues,
  getWarnings,
  getAggregateStats,
  getProblemQueues,
} from "~/lib/queries.server";
import { StatsCards } from "~/components/stats-cards";
import { Card, CardHeader, CardTitle, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { ErrorCard } from "~/components/error-card";
import {
  formatTimeAgo,
  WARNING_TYPE_VARIANTS,
  WARNING_TYPE_LABELS,
} from "~/lib/utils";
import type { WarningType, QueueResult, WarningResult } from "~/lib/types";

export async function loader({ context }: Route.LoaderArgs) {
  // Fetch data in parallel, limiting queues to what we'll display
  const [queues, warnings, stats, problemQueues] = await Promise.all([
    getQueues(context.DB_URL, context.SCHEMA, { limit: 10 }), // Only fetch first 10 for overview
    getWarnings(context.DB_URL, context.SCHEMA, { limit: 5 }),
    getAggregateStats(context.DB_URL, context.SCHEMA),
    getProblemQueues(context.DB_URL, context.SCHEMA, 5), // Get top 5 problem queues
  ]);

  return { stats, queues, warnings, problemQueues };
}

export function ErrorBoundary() {
  return <ErrorCard title="Failed to load dashboard" />;
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { stats, queues, warnings, problemQueues } = loaderData;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Monitor your pg-boss job queues
        </p>
      </div>

      <StatsCards stats={stats} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Problem Queues */}
        <Card>
          <CardHeader>
            <CardTitle>Queues Needing Attention</CardTitle>
          </CardHeader>
          <CardContent>
            {problemQueues.length === 0 ? (
              <p className="text-sm text-gray-500">
                All queues are healthy
              </p>
            ) : (
              <ul className="space-y-3">
                {problemQueues.map((queue: QueueResult) => (
                  <li key={queue.name}>
                    <Link
                      to={`/queues/${encodeURIComponent(queue.name)}`}
                      className="flex items-center justify-between p-3 bg-error-50 rounded-lg hover:bg-error-100 transition-colors"
                    >
                      <div>
                        <p className="font-medium text-gray-900">{queue.name}</p>
                        <p className="text-sm text-gray-500">
                          {queue.queuedCount.toLocaleString()} queued (threshold: {queue.warningQueued.toLocaleString()})
                        </p>
                      </div>
                      <Badge variant="error">High Backlog</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent Warnings */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Warnings</CardTitle>
            <Link
              to="/warnings"
              className="text-sm font-medium text-primary-600 hover:text-primary-700"
            >
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {warnings.length === 0 ? (
              <p className="text-sm text-gray-500">
                No warnings recorded
              </p>
            ) : (
              <ul className="space-y-3">
                {warnings.map((warning: WarningResult) => (
                  <li
                    key={warning.id}
                    className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg"
                  >
                    <WarningIcon className="w-5 h-5 text-warning-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          variant={WARNING_TYPE_VARIANTS[warning.type as WarningType]}
                          size="sm"
                        >
                          {WARNING_TYPE_LABELS[warning.type as WarningType]}
                        </Badge>
                        <span className="text-xs text-gray-400">
                          {formatTimeAgo(new Date(warning.createdOn))}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 truncate">
                        {warning.message}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Queues Overview */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>All Queues ({stats.queueCount})</CardTitle>
          <Link
            to="/queues"
            className="text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            View all
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Policy
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Queued
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Active
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {queues.map((queue: QueueResult) => (
                  <tr key={queue.name} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Link
                        to={`/queues/${encodeURIComponent(queue.name)}`}
                        className="text-sm font-medium text-primary-600 hover:text-primary-700"
                      >
                        {queue.name}
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge variant="gray" size="sm">
                        {queue.policy}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-700">
                      {queue.queuedCount.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-700">
                      {queue.activeCount.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-700">
                      {queue.totalCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function WarningIcon({ className }: { className?: string }) {
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
  );
}
