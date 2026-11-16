import { useId } from 'react'
import { useLocation, useNavigate, useParams, useRouteLoaderData, useSearchParams } from 'react-router'
import { switchPathname } from '~/lib/schema-switch'
import { cn } from '~/lib/utils'
import { Check, ChevronsUpDown, Layers } from 'lucide-react'
import type { PublicSchema } from '~/lib/types'
import { ProSlot } from '~/components/pro-slot'
import { SCHEMA_COLORS, schemaColor } from '~/lib/schema-colors'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

interface RootLoaderData {
  schemas: PublicSchema[]
  internal?: PublicSchema[]
  currentSchema: PublicSchema | undefined
}

function Dot ({ schema, index }: { schema: PublicSchema, index: number }) {
  return <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: SCHEMA_COLORS[schemaColor(schema.color, index)] }} />
}

/** An overlay's own schema: a tile in place of a configured schema's dot, so the two never read alike. */
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

function Name ({ schema }: { schema: PublicSchema }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <span className="truncate font-medium">{schema.name}</span>
      {schema.badge && <span className="pgboss-tier shrink-0">{schema.badge}</span>}
    </span>
  )
}

/**
 * The schema every page is reading, first in the topbar the way Supabase shows its project, so it
 * is in view on every page and at every width. A menu when there is more than one, a plain label when
 * there is not.
 */
export function SchemaSwitcher () {
  const root = useRouteLoaderData('root') as RootLoaderData | undefined
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams()
  const ids = useId()

  const schemas = root?.schemas ?? []
  const internal = root?.internal ?? []
  const current = root?.currentSchema

  if (!current) return null

  const isInternal = internal.some((schema) => schema.id === current.id)
  const index = Math.max(0, schemas.findIndex((schema) => schema.id === current.id))
  const label = (
    <>
      {/* On a phone a badge marks an internal schema alone, leaving its name the room. */}
      {isInternal ? <InternalMark className={current.badge ? 'max-sm:hidden' : undefined} /> : <Dot schema={current} index={index} />}
      <span className="min-w-0 max-w-[14rem] text-[var(--text-primary)] max-sm:max-w-[9rem]"><Name schema={current} /></span>
    </>
  )

  // Named even for the first schema: without `?schema=` a remembered `pgboss_schema` cookie would win, and
  // switching back to the first would land on the schema just left. Links elsewhere stay short.
  // A page about one item lands on its list instead, with none of the item's own query string.
  const select = (id: string) => {
    const pathname = switchPathname(location.pathname, routeParams)
    const next = new URLSearchParams(pathname === location.pathname ? params : undefined)
    next.set('schema', id)
    navigate({ pathname, search: `?${next.toString()}` })
  }

  if (schemas.length + internal.length <= 1) {
    return <span className="inline-flex h-8 min-w-0 items-center gap-2 text-sm" title="Schema">{label}</span>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Schema: ${current.name}. Switch schema`}
        className="-ml-2 inline-flex h-8 min-w-0 cursor-pointer items-center gap-2 max-sm:gap-1.5 rounded-md px-2 text-sm text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] data-popup-open:bg-[var(--surface-hover)]"
      >
        {label}
        <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[18rem]">
        {/* Each section a group named by its heading, and each schema a radio item: one is
            the database every page reads, and a screen reader says which. */}
        <DropdownMenuGroup aria-labelledby={`${ids}-schemas`}>
          <DropdownMenuLabel id={`${ids}-schemas`} className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">Schemas</DropdownMenuLabel>
          {schemas.map((schema, k) => (
            <DropdownMenuItem
              key={schema.id}
              role="menuitemradio"
              aria-checked={schema.id === current.id}
              onClick={() => select(schema.id)}
              className="cursor-pointer gap-2.5 py-2"
            >
              <Dot schema={schema} index={k} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{schema.name}</span>
                <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">{schema.connection.schema}</span>
              </span>
              {schema.id === current.id && <Check aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-primary-500" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {internal.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup aria-labelledby={`${ids}-internal`}>
              <DropdownMenuLabel id={`${ids}-internal`} className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">Internal</DropdownMenuLabel>
              {internal.map((schema) => (
                <DropdownMenuItem
                  key={schema.id}
                  role="menuitemradio"
                  aria-checked={schema.id === current.id}
                  onClick={() => select(schema.id)}
                  className="cursor-pointer gap-2.5 py-2"
                >
                  <InternalMark />
                  <span className="flex min-w-0 flex-col">
                    <Name schema={schema} />
                    <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">{schema.connection.schema}</span>
                  </span>
                  {schema.id === current.id && <Check aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-primary-500" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">Each schema has its own queues, jobs and history.</p>
        <ProSlot name="schemaMenuEnd" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
