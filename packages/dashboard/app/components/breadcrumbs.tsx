import { Fragment } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { MoreHorizontal } from 'lucide-react'
import { DbLink, resolveDbHref } from './db-link'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { cn } from '~/lib/utils'

export function Breadcrumbs() {
  const location = useLocation()

  // Build breadcrumb items based on current path
  const pathSegments = location.pathname.split('/').filter(Boolean)

  if (pathSegments.length === 0) {
    return null
  }

  // Every trail starts with a link back to the Home (overview) page.
  const breadcrumbs: Array<{ label: string; href?: string }> = [
    { label: 'Home', href: '/' },
  ]

  // Handle different route patterns
  if (pathSegments[0] === 'queues') {
    breadcrumbs.push({ label: 'Queues', href: '/queues' })

    if (pathSegments.length > 1 && pathSegments[1] !== 'queues') {
      const queueName = decodeURIComponent(pathSegments[1])
      breadcrumbs.push({ label: queueName, href: `/queues/${encodeURIComponent(queueName)}` })

      // The page leads with the job id in full, so the trail names the page rather than repeat it.
      if (pathSegments.length > 2 && pathSegments[2] === 'jobs' && pathSegments[3]) {
        breadcrumbs.push({ label: 'Job Detail' })
      }
    }
  } else if (pathSegments[0] === 'schedules') {
    breadcrumbs.push({ label: 'Schedules', href: '/schedules' })

    if (pathSegments.length > 1) {
      const scheduleName = decodeURIComponent(pathSegments[1])
      breadcrumbs.push({ label: scheduleName })
    }
  } else if (pathSegments[0] === 'migrations') {
    breadcrumbs.push({ label: 'Migrations', href: '/migrations' })

    if (pathSegments[1]) {
      breadcrumbs.push({ label: decodeURIComponent(pathSegments[1]).slice(0, 8) })
    }
  } else if (pathSegments[0] === 'subscriptions') {
    breadcrumbs.push({ label: 'Subscriptions', href: '/subscriptions' })

    if (pathSegments[1]) {
      breadcrumbs.push({ label: decodeURIComponent(pathSegments[1]) })
    }
  } else if (pathSegments[0] === 'jobs') {
    breadcrumbs.push({ label: 'Jobs' })
  } else if (pathSegments[0] === 'warnings') {
    breadcrumbs.push({ label: 'Warnings', href: '/warnings' })

    if (pathSegments[1]) {
      breadcrumbs.push({ label: decodeURIComponent(pathSegments[1]).slice(0, 8) })
    }
  } else if (pathSegments[0] === 'instances') {
    breadcrumbs.push({ label: 'Instances', href: '/instances' })

    // One registered row: its id is the only thing that names it, since names may repeat.
    if (pathSegments[1]) {
      breadcrumbs.push({ label: decodeURIComponent(pathSegments[1]).slice(0, 8) })
    }
  }

  // Only the Home root and no page-specific crumb (unmatched route) — show nothing.
  if (breadcrumbs.length <= 1) {
    return null
  }

  return <Trail crumbs={breadcrumbs.map((crumb) => ({ label: crumb.label, to: crumb.href }))} />
}

export interface Crumb {
  label: string
  /** Omitted for the page you are on, which is never a link. */
  to?: string
}

/**
 * A breadcrumb trail, shared by the free pages and the Pro Console's. When the topbar is too narrow
 * for all of it (a phone, or a narrow window with the sidebar open) it keeps Home and the page you
 * are on, and the crumbs between collapse into an ellipsis that opens them as a menu. Narrow is the
 * topbar's own width, a container query, so it holds whatever takes the room.
 */
export function Trail ({ crumbs }: { crumbs: Crumb[] }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const middle = crumbs.slice(1, -1)

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-2 text-sm text-[var(--text-tertiary)]">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          const between = index > 0 && !last

          return (
            <Fragment key={`${crumb.label}-${index}`}>
              {/* Where the collapsed crumbs go: after Home, only while they are hidden. */}
              {index === 1 && middle.length > 0 && (
                <li className="hidden shrink-0 items-center gap-2 @max-xl:flex">
                  <span aria-hidden="true">/</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`${middle.length} more`}
                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    >
                      <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {middle.map((hidden, k) => (
                        <DropdownMenuItem
                          key={`${hidden.label}-${k}`}
                          disabled={!hidden.to}
                          onClick={() => { if (hidden.to) navigate(resolveDbHref(hidden.to, params.get('db'))) }}
                        >
                          {hidden.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )}
              <li className={cn('flex items-center gap-2', last ? 'min-w-0' : 'shrink-0', between && '@max-xl:hidden')}>
                {index > 0 && <span aria-hidden="true">/</span>}
                {crumb.to && !last
                  ? (
                    // `DbLink`, so the trail keeps the database somebody selected.
                    <DbLink to={crumb.to} className="hover:text-[var(--text-primary)]">{crumb.label}</DbLink>
                    )
                  : (
                    <span
                      aria-current={last ? 'page' : undefined}
                      className={cn(last && 'truncate font-medium text-[var(--text-primary)]')}
                      title={last ? crumb.label : undefined}
                    >
                      {crumb.label}
                    </span>
                    )}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
