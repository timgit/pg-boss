import type { Route } from './+types/queue-names'
import { dbContext } from '~/lib/db-context'
import { searchQueueNames } from '~/lib/queries.server'

/**
 * The queue names containing `?q=`, a page at a time, for the queue pickers to fetch as the reader
 * types. Its own path, since `/queues/search` would hide a queue named `search`.
 */
export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const search = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  return searchQueueNames(DB_URL, SCHEMA, search)
}

export type QueueNamesResult = Awaited<ReturnType<typeof loader>>
