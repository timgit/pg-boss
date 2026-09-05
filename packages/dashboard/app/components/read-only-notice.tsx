import { Card, CardContent } from '~/components/ui/card'
import { Eye } from 'lucide-react'

/**
 * Stands in for a form when the dashboard is read-only. The three creation routes
 * (`/send`, `/queues/create`, `/schedules/new`) stay reachable — a bookmark or a
 * stale link should explain itself rather than 404 — but they render this instead
 * of a form that could only ever be refused.
 */
export function ReadOnlyNotice ({ action }: { action: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-6">
        <Eye className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            This dashboard is read-only
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {action} is disabled because the server was started with
            {' '}<code className="font-mono text-xs">PGBOSS_DASHBOARD_READ_ONLY=1</code>.
            Unset it to restore write access.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
