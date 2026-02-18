import { redirect } from 'react-router'
import type { Route } from './+types/search'
import { findJobById } from '~/lib/queries.server'
import { Card, CardContent } from '~/components/ui/card'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function loader ({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const jobId = url.searchParams.get('jobId')?.trim()

  if (!jobId) {
    return { error: null }
  }

  if (!UUID_REGEX.test(jobId)) {
    return { error: 'Invalid job ID format. Please enter a valid UUID.' }
  }

  const job = await findJobById(context.DB_URL, context.SCHEMA, jobId)

  if (!job) {
    return { error: `Job not found: ${jobId}` }
  }

  // Preserve the db param for multi-database setups
  const dbParam = url.searchParams.get('db')
  const target = `/queues/${encodeURIComponent(job.name)}/jobs/${job.id}${dbParam ? `?db=${encodeURIComponent(dbParam)}` : ''}`
  throw redirect(target)
}

export default function Search ({ loaderData }: Route.ComponentProps) {
  const { error } = loaderData

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Search</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Find a job by its ID
        </p>
      </div>

      {error && (
        <Card>
          <CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">
            {error}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
