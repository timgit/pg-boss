import { useLocation, useNavigate, useRouteLoaderData, useSearchParams } from 'react-router'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { PublicDatabase } from '~/lib/types'
import { DATABASE_COLORS, databaseColor } from '~/lib/database-colors'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

interface RootLoaderData {
  databases: PublicDatabase[]
  currentDb: PublicDatabase | undefined
}

function Dot ({ db, index }: { db: PublicDatabase, index: number }) {
  return <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: DATABASE_COLORS[databaseColor(db.color, index)] }} />
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

  const databases = root?.databases ?? []
  const current = root?.currentDb

  if (!current) return null

  const index = Math.max(0, databases.findIndex((db) => db.id === current.id))
  const label = (
    <>
      <Dot db={current} index={index} />
      <span className="max-w-[14rem] truncate font-medium text-[var(--text-primary)] max-sm:max-w-[9rem]">{current.name}</span>
    </>
  )

  // The first database is the default and needs no `?db=`, so links stay short for most people.
  const select = (id: string) => {
    const next = new URLSearchParams(params)
    if (id === databases[0]?.id) {
      next.delete('db')
    } else {
      next.set('db', id)
    }
    const search = next.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' })
  }

  if (databases.length <= 1) {
    return <span className="inline-flex h-8 min-w-0 items-center gap-2 text-sm" title="Database">{label}</span>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Database: ${current.name}. Switch database`}
        className="-ml-2 inline-flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] data-popup-open:bg-[var(--surface-hover)]"
      >
        {label}
        <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[18rem]">
        <DropdownMenuLabel className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">Databases</DropdownMenuLabel>
        {databases.map((db, k) => (
          <DropdownMenuItem
            key={db.id}
            aria-current={db.id === current.id ? 'true' : undefined}
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
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">Each database has its own queues, jobs and history.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
