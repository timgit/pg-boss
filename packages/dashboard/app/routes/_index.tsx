import type { RouterContextProvider } from 'react-router'
import { dbContext } from '~/lib/db-context'
import { loadOverview, type OverviewData } from '~/lib/overview.server'
import { OverviewHeader, OverviewSections } from '~/components/overview'
import { ErrorCard } from '~/components/error-card'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Overview' }

// Typed by hand rather than from `./+types/_index`: a Pro build replaces this route with its own
// overview, React Router then generates no types for it, and the build still typechecks this file.

export async function loader ({ context }: { context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  return loadOverview(DB_URL, SCHEMA)
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return <ErrorCard title="Failed to load dashboard" error={error} />
}

export default function Overview ({ loaderData }: { loaderData: OverviewData }) {
  return (
    <div>
      <OverviewHeader />
      <OverviewSections data={loaderData} />
    </div>
  )
}
