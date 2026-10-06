import type { RouterContextProvider } from 'react-router'
import { dbContext } from '~/lib/db-context'
import { loadInstancePage, type InstancePageData } from '~/lib/instances.server'
import { InstancePage } from '~/components/instance-page'
import { useRegistryRefresh } from '~/components/instances-table'
import { ErrorCard } from '~/components/error-card'
import type { TitleHandle } from '~/lib/page-title'
import { instanceName } from '~/lib/instances'

/** The browser tab's name for this page. */
export const handle: TitleHandle<InstancePageData | undefined> = { title: ({ data }) => (data ? `${instanceName(data.instance.name)} ${data.instance.id.slice(0, 8)}` : null) }

// Typed by hand rather than from `./+types/instances.$id`: a Pro build replaces this route with its
// own, React Router then generates no types for it, and the build still typechecks this file.

export async function loader ({ params, context }: { params: { id?: string }, context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  return loadInstancePage(DB_URL, SCHEMA, params.id ?? '')
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Failed to load instance"
      error={error}
      backTo={{ href: '/instances', label: 'Back to Instances' }}
    />
  )
}

export default function InstanceDetail ({ loaderData }: { loaderData: InstancePageData }) {
  useRegistryRefresh(true)
  return <InstancePage data={loaderData} />
}
