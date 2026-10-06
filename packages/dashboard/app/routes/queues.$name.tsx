import type { RouterContextProvider } from 'react-router'
import { dbContext } from '~/lib/db-context'
import { loadQueuePage, type QueuePageData } from '~/lib/queue-page.server'
import { QueuePage } from '~/components/queue-page'
import { ErrorCard } from '~/components/error-card'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => params.name ?? null }

// Typed by hand rather than from `./+types/queues.$name`: a Pro build replaces this route with its
// own, React Router then generates no types for it, and the build still typechecks this file.

export async function loader ({ params, request, context }: { params: { name?: string }, request: Request, context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  return loadQueuePage(DB_URL, SCHEMA, params.name ?? '', request)
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Failed to load queue"
      error={error}
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function QueueDetail ({ loaderData }: { loaderData: QueuePageData }) {
  return <QueuePage data={loaderData} />
}
