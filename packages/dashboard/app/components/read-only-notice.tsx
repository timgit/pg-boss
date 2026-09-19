import { Card, CardContent } from '~/components/ui/card'
import { Eye } from 'lucide-react'
import { useDenial } from '~/lib/use-capabilities'

/**
 * Stands in for a form the current person may not submit. The three creation
 * routes (`/send`, `/queues/create`, `/schedules/new`) stay reachable — a bookmark
 * or a stale link should explain itself rather than 404 — but they render this
 * instead of a form that could only ever be refused.
 *
 * The wording comes from the root loader rather than being written here, because
 * the reason is not always read-only mode. Telling someone whose role is `viewer`
 * to unset an environment variable sends them to an operator they may not have
 * and a setting that is not the cause; the overlay supplies its own sentence, and
 * the free dashboard's names the variable exactly as before.
 */
export function ReadOnlyNotice ({ action }: { action: string }) {
  const denial = useDenial()

  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-6">
        <Eye className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {denial.title}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {action} is disabled. {denial.detail}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
