import type { Route } from './+types/queue-names'
import { schemaContext } from '~/lib/schema-context'
import { searchQueueNames } from '~/lib/queries.server'

/**
 * The queue names containing `?q=`, a page at a time, for the queue pickers to fetch as the reader
 * types. Its own path, since `/queues/search` would hide a queue named `search`.
 */
export async function loader ({ request, context }: Route.LoaderArgs) {
  const { connection } = context.get(schemaContext)
  const search = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  return searchQueueNames(connection.url, connection.schema, search)
}

export type QueueNamesResult = Awaited<ReturnType<typeof loader>>
