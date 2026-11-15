import type { RouterContextProvider } from 'react-router'
import { schemaContext } from '~/lib/schema-context'
import { loadOverview, type OverviewData } from '~/lib/overview.server'
import { OverviewHeader, OverviewSections } from '~/components/overview'
import { ErrorCard } from '~/components/error-card'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Overview' }

// Typed by hand rather than from `./+types/_index`: a Pro build replaces this route with its own
// overview, React Router then generates no types for it, and the build still typechecks this file.

export async function loader ({ context }: { context: Readonly<RouterContextProvider> }) {
  const { connection } = context.get(schemaContext)
  return loadOverview(connection.url, connection.schema)
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return <ErrorCard title="Error loading the overview" error={error} />
}

export default function Overview ({ loaderData }: { loaderData: OverviewData }) {
  return (
    <div>
      <OverviewHeader />
      <OverviewSections data={loaderData} />
    </div>
  )
}
