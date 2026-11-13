import { useRouteLoaderData } from 'react-router'
import { Button } from '~/components/ui/button'
import { DbLink } from '~/components/db-link'
import { ProSlot, hasProSlot } from '~/components/pro-slot'

/** Whether `PGBOSS_DASHBOARD_READ_ONLY` is on, as the root loader read it. */
export function useReadOnly (): boolean {
  const root = useRouteLoaderData('root') as { readOnly?: boolean } | undefined
  return root?.readOnly === true
}

/** Opens the send form, on `queue` when it's given. Nothing in read-only mode. */
export function SendJobButton ({ queue }: { queue?: string }) {
  if (useReadOnly()) return null

  return (
    <Button variant="primary" size="md" render={<DbLink to={queue ? `/send?${new URLSearchParams({ queue })}` : '/send'} />}>
      Send job
    </Button>
  )
}

/** A page header's actions: the overlay's, when one fills `pageActions`, or the dashboard's Send job. */
export function PageActions ({ page }: { page: 'overview' | 'jobs' }) {
  return hasProSlot('pageActions') ? <ProSlot name="pageActions" page={page} /> : <SendJobButton />
}
