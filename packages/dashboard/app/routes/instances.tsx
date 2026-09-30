import { useEffect, useRef } from 'react'
import { useRevalidator, type ShouldRevalidateFunctionArgs } from 'react-router'
import type { Route } from './+types/instances'
import { getInstanceRegistry } from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { ErrorCard } from '~/components/error-card'
import { PageHeader } from '~/components/ui/page-header'
import { InstancesTable } from '~/components/instances-table'
import { ProSlot } from '~/components/pro-slot'

// Heartbeats land every 30 seconds by default, so a list read once goes stale within a minute.
const REFRESH_MS = 15_000

export async function loader ({ context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  return getInstanceRegistry(DB_URL, SCHEMA)
}

// Opening a row only changes `?instance=`; that is the list's, not a reason to read the registry again.
export function shouldRevalidate ({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  const without = (url: URL) => {
    const params = new URLSearchParams(url.search)
    params.delete('instance')
    return `${url.pathname}?${params}`
  }
  if (currentUrl.href !== nextUrl.href && without(currentUrl) === without(nextUrl)) return false
  return defaultShouldRevalidate
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return (
    <ErrorCard
      title="Failed to load instances"
      error={error}
      backTo={{ href: '/', label: 'Back to Dashboard' }}
    />
  )
}

// Re-reads the registry while the tab is visible, and the moment it is shown again. The revalidator
// is read through a ref so the interval is not restarted by the re-render each refresh causes.
function useRefresh (enabled: boolean) {
  const revalidator = useRevalidator()
  const latest = useRef(revalidator)
  latest.current = revalidator

  useEffect(() => {
    if (!enabled) return
    const refresh = () => {
      if (document.visibilityState === 'visible' && latest.current.state === 'idle') latest.current.revalidate()
    }
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [enabled])
}

export default function Instances ({ loaderData }: Route.ComponentProps) {
  const { available, instances, checkedOn } = loaderData
  useRefresh(available)

  const live = instances.filter((i) => i.live)
  const hosts = new Set(live.map((i) => i.host)).size

  return (
    <div className="space-y-4">
      <PageHeader
        title="Instances"
        subtitle={available
          ? `Every pg-boss instance registered in this database: ${live.length} live on ${hosts === 1 ? 'one host' : `${hosts} hosts`}`
          : 'The pg-boss instances that share this database'}
      />

      {available
        ? (
          <>
            <ProSlot name="instancesOverview" instances={instances} checkedOn={checkedOn} />
            <InstancesTable instances={instances} checkedOn={checkedOn} />
            <p className="text-xs text-[var(--text-tertiary)]">
              Instances register from pg-boss 12.36. Older versions, and any started
              with <code className="font-mono">registerInstance: false</code>, connect without appearing here. A row goes
              quiet after three missed heartbeats, and is deleted a week after its last one.
            </p>
          </>
          )
        : (
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            This database's pg-boss schema predates the instance registry. Instances appear here once it is
            migrated by pg-boss 12.36 or later.
          </p>
          )}
    </div>
  )
}
