import { useId } from 'react'
import { useLocation, useNavigate, useParams, useRouteLoaderData, useSearchParams } from 'react-router'
import { switchPathname } from '~/lib/database-switch'
import { cn } from '~/lib/utils'
import { Check, ChevronsUpDown, Layers } from 'lucide-react'
import type { PublicDatabase } from '~/lib/types'
import { DATABASE_COLORS, databaseColor } from '~/lib/database-colors'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { term } from '~/lib/terms'

interface RootLoaderData {
  databases: PublicDatabase[]
  internal?: PublicDatabase[]
  currentDb: PublicDatabase | undefined
}

function Dot ({ db, index }: { db: PublicDatabase, index: number }) {
  return <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: DATABASE_COLORS[databaseColor(db.color, index)] }} />
}

/** An overlay's own schema: a tile in place of a configured database's dot, so the two never read alike. */
function InternalMark ({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-[var(--text-link)]', className)}
      style={{ background: 'color-mix(in srgb, var(--primary-500) 12%, transparent)' }}
    >
      <Layers className="h-3 w-3" />
    </span>
  )
}

function Name ({ db }: { db: PublicDatabase }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <span className="truncate font-medium">{db.name}</span>
      {db.badge && <span className="pgboss-tier shrink-0">{db.badge}</span>}
    </span>
  )
}

/**
 * The database every page is reading, first in the topbar the way Supabase shows its project, so it
 * is in view on every page and at every width. A menu when there is more than one, a plain label when
 * there is not.
 */
export function DatabaseSwitcher () {
  const root = useRouteLoaderData('root') as RootLoaderData | undefined
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams()
  const ids = useId()

  const databases = root?.databases ?? []
  const internal = root?.internal ?? []
  const current = root?.currentDb

  if (!current) return null

  const isInternal = internal.some((db) => db.id === current.id)
  const index = Math.max(0, databases.findIndex((db) => db.id === current.id))
  const label = (
    <>
      {/* On a phone a badge marks an internal database alone, leaving its name the room. */}
      {isInternal ? <InternalMark className={current.badge ? 'max-sm:hidden' : undefined} /> : <Dot db={current} index={index} />}
      <span className="min-w-0 max-w-[14rem] text-[var(--text-primary)] max-sm:max-w-[9rem]"><Name db={current} /></span>
    </>
  )

  // Named even for the first database: without `?db=` a remembered `pgboss_db` cookie would win, and
  // switching back to the first would land on the database just left. Links elsewhere stay short.
  // A page about one item lands on its list instead, with none of the item's own query string.
  const select = (id: string) => {
    const pathname = switchPathname(location.pathname, routeParams)
    const next = new URLSearchParams(pathname === location.pathname ? params : undefined)
    next.set(term.param, id)
    navigate({ pathname, search: `?${next.toString()}` })
  }

  if (databases.length + internal.length <= 1) {
    return <span className="inline-flex h-8 min-w-0 items-center gap-2 text-sm" title={term.One}>{label}</span>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${term.One}: ${current.name}. Switch ${term.one}`}
        className="-ml-2 inline-flex h-8 min-w-0 cursor-pointer items-center gap-2 max-sm:gap-1.5 rounded-md px-2 text-sm text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] data-popup-open:bg-[var(--surface-hover)]"
      >
        {label}
        <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[18rem]">
        {/* Each section a group named by its heading, and each database a radio item: one is
            the database every page reads, and a screen reader says which. */}
        <DropdownMenuGroup aria-labelledby={`${ids}-databases`}>
          <DropdownMenuLabel id={`${ids}-databases`} className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">{term.Many}</DropdownMenuLabel>
          {databases.map((db, k) => (
            <DropdownMenuItem
              key={db.id}
              role="menuitemradio"
              aria-checked={db.id === current.id}
              onClick={() => select(db.id)}
              className="cursor-pointer gap-2.5 py-2"
            >
              <Dot db={db} index={k} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{db.name}</span>
                <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">{db.schema}</span>
              </span>
              {db.id === current.id && <Check aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-primary-500" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {internal.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup aria-labelledby={`${ids}-internal`}>
              <DropdownMenuLabel id={`${ids}-internal`} className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">Internal</DropdownMenuLabel>
              {internal.map((db) => (
                <DropdownMenuItem
                  key={db.id}
                  role="menuitemradio"
                  aria-checked={db.id === current.id}
                  onClick={() => select(db.id)}
                  className="cursor-pointer gap-2.5 py-2"
                >
                  <InternalMark />
                  <span className="flex min-w-0 flex-col">
                    <Name db={db} />
                    <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">{db.schema}</span>
                  </span>
                  {db.id === current.id && <Check aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-primary-500" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">Each {term.one} has its own queues, jobs and history.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
