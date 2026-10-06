import type { RouterContextProvider } from 'react-router'
import { dbContext } from '~/lib/db-context'
import { loadInstances, type InstancesData } from '~/lib/instances.server'
import { ErrorCard } from '~/components/error-card'
import { PageHeader } from '~/components/ui/page-header'
import { InstancesTable, RegistryFootnote, RegistryUnavailable, useRegistryRefresh } from '~/components/instances-table'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Instances' }

// Typed by hand rather than from `./+types/instances`: a Pro build replaces this route with its
// own, React Router then generates no types for it, and the build still typechecks this file.

export async function loader ({ context }: { context: Readonly<RouterContextProvider> }) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  return loadInstances(DB_URL, SCHEMA)
}

export function ErrorBoundary ({ error }: { error: unknown }) {
  return (
    <ErrorCard
      title="Failed to load instances"
      error={error}
      backTo={{ href: '/', label: 'Back to Dashboard' }}
    />
  )
}

export default function Instances ({ loaderData }: { loaderData: InstancesData }) {
  const { available, instances, checkedOn } = loaderData
  useRegistryRefresh(available)

  const live = instances.filter((i) => i.live)
  const hosts = new Set(live.map((i) => i.host)).size

  return (
    <div className="space-y-4">
      <PageHeader
        title="Instances"
        subtitle={available
          ? `Every instance registered in this database: ${live.length} live on ${hosts === 1 ? 'one host' : `${hosts} hosts`}`
          : 'The instances that share this database'}
      />

      {available
        ? (
          <>
            <InstancesTable instances={instances} checkedOn={checkedOn} />
            <RegistryFootnote />
          </>
          )
        : <RegistryUnavailable />}
    </div>
  )
}
