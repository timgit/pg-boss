import type { RouterContextProvider } from 'react-router'
import { dbContext } from '~/lib/db-context'
import { loadQueueList, type QueueListData } from '~/lib/queue-list.server'
import { QueueList } from '~/components/queue-list'
import { ErrorCard } from '~/components/error-card'

// Typed by hand rather than from `./+types/queues._index`: a Pro build replaces this route with its
// own, React Router then generates no types for it, and the build still typechecks this file.

export async function loader ({ request, context }: { request: Request, context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  return loadQueueList(DB_URL, SCHEMA, request)
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Failed to load queues"
      error={error}
      backTo={{ href: '/', label: 'Back to Dashboard' }}
    />
  )
}

export default function QueuesIndex ({ loaderData }: { loaderData: QueueListData }) {
  return <QueueList data={loaderData} />
}
