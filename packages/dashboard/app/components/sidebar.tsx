import { NavLink, useRouteLoaderData, useSearchParams, useNavigate, useLocation, useMatch } from 'react-router'
import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import overlay from '~pro'
import { ProSlot } from '~/components/pro-slot'
import { ThemeToggle } from '~/components/ui/theme-toggle'
import { ColorThemePicker } from '~/components/ui/color-theme-picker'
import { cn } from '~/lib/utils'
import type { PublicDatabase } from '~/lib/types'
import markWhite from '~/assets/pg-boss-mark-white.svg?raw'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '~/components/ui/sidebar'

interface RootLoaderData {
  databases: PublicDatabase[]
  currentDb: PublicDatabase
}

const navigation = [
  { name: 'Overview', href: '/', icon: HomeIcon },
  { name: 'Jobs', href: '/jobs', icon: JobsIcon },
  { name: 'Queues', href: '/queues', icon: QueueIcon },
  { name: 'Schedules', href: '/schedules', icon: SchedulesIcon },
  { name: 'Migrations', href: '/migrations', icon: MigrationsIcon },
  { name: 'Warnings', href: '/warnings', icon: WarningIcon },
  ...overlay.nav,
]

function HomeIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  )
}

function JobsIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
    </svg>
  )
}

function QueueIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
    </svg>
  )
}

function SchedulesIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  )
}

function WarningIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  )
}

function MigrationsIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  )
}

function DatabaseIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
    </svg>
  )
}

function ChevronIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  )
}

function DatabaseSelector ({
  databases,
  currentDb,
  onSelect,
}: {
  databases: PublicDatabase[]
  currentDb: PublicDatabase
  onSelect: (db: PublicDatabase) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ top: number, left: number, width: number } | null>(null)

  const updateMenuPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      setMenuPosition({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 256) })
    }
  }, [])

  // While open, the menu is `fixed` relative to the viewport, so keep it pinned
  // to the button as the page scrolls or the window resizes. Capture-phase scroll
  // catches scrolling in any ancestor, not just the window.
  useEffect(() => {
    if (!isOpen) return
    window.addEventListener('scroll', updateMenuPosition, true)
    window.addEventListener('resize', updateMenuPosition)
    return () => {
      window.removeEventListener('scroll', updateMenuPosition, true)
      window.removeEventListener('resize', updateMenuPosition)
    }
  }, [isOpen, updateMenuPosition])

  if (databases.length <= 1) {
    return null
  }

  const openMenu = () => {
    updateMenuPosition()
    setIsOpen(true)
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors cursor-pointer',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <DatabaseIcon className="w-4 h-4 flex-shrink-0" />
          <span className="font-medium truncate">{currentDb.name}</span>
        </div>
        <ChevronIcon className={cn('w-4 h-4 flex-shrink-0 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && menuPosition && typeof document !== 'undefined' && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          {/* Dropdown rendered in a portal so it is not clipped by the sidebar's overflow */}
          <div
            className={cn(
              'fixed rounded-lg shadow-lg z-50 py-1',
              'bg-sidebar border border-sidebar-border'
            )}
            style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width }}
          >
            {databases.map((db) => (
              <button
                key={db.id}
                type="button"
                onClick={() => {
                  onSelect(db)
                  setIsOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors cursor-pointer text-sidebar-foreground',
                  db.id === currentDb.id
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                )}
              >
                <DatabaseIcon className={cn('w-4 h-4 flex-shrink-0')} />
                <span className="truncate">{db.name}</span>
                {db.schema !== 'pgboss' && (
                  <span className="ml-auto text-xs opacity-70">({db.schema})</span>
                )}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

/*
  One nav row. `render` hands the menu button's props to the NavLink so the row is a
  single <a>: rendered as siblings the way this used to be, the button nested inside
  the anchor was interactive content inside a link — invalid HTML, and an accessibility
  tree with a button buried in a link.

  Losing NavLink's `isActive` render prop in the trade, the match is asked for directly.
  `useMatch` is the same matcher NavLink uses, with `end` set the same way, so the two
  cannot drift; it is a hook, which is why this is a component rather than inline JSX.
  The href carries the `?db=` param but the match is asked about the path alone —
  NavLink ignores the search string when matching, and so must this.
*/
function NavItem ({
  item,
  href,
  onNavigate,
}: {
  item: (typeof navigation)[number]
  href: string
  onNavigate: () => void
}) {
  const end = item.href === '/'
  const isActive = useMatch({ path: item.href, end }) !== null

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        tooltip={item.name}
        render={<NavLink to={href} end={end} onClick={onNavigate} />}
      >
        <item.icon className="h-5 w-5 flex-shrink-0" />
        <span className="whitespace-nowrap group-data-[state=collapsed]:hidden">{item.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AppSidebar () {
  const rootData = useRouteLoaderData('root') as RootLoaderData | undefined
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { setOpenMobile } = useSidebar()

  const databases = rootData?.databases || []
  const currentDb = rootData?.currentDb
  const dbParam = searchParams.get('db')

  const handleDatabaseSelect = (db: PublicDatabase) => {
    const params = new URLSearchParams(searchParams)
    if (db.id === databases[0]?.id) {
      params.delete('db')
    } else {
      params.set('db', db.id)
    }
    const newSearch = params.toString()
    navigate({
      pathname: location.pathname,
      search: newSearch ? `?${newSearch}` : '',
    })
  }

  const buildHref = (path: string) => {
    if (!dbParam) return path
    return `${path}?db=${dbParam}`
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2.5 pl-1.5 pr-3 py-2">
          {/*
            The square is a themed element and the glyph is the knockout mark on
            top of it, rather than one image carrying both. An <img> is an
            isolated document, so no CSS of ours can reach the square inside it —
            and the square has to follow the colour theme the way it always has.

            The knockout keeps the full 160 viewBox, so the glyph sits at exactly
            the inset it has inside the drawn square. The radius is the brand's
            own 36/160 of the width rather than a chosen number: 32 × 0.225 = 7.2.

            This is the full mark, letterforms over the queue row. The favicon is
            a different asset carrying only the queue row, because at 16px these
            letterforms close up into a smudge.
          */}
          {/*
            Inlined rather than referenced by URL. An imported asset URL is
            absolute and is baked into this chunk, which `withBasePath` cannot
            rewrite when the dashboard is mounted under a prefix — the build's
            portability check fails on it. The markup is the overlay's own SVG,
            not anything a request supplied.
          */}
          <div
            className="w-8 h-8 rounded-[7.2px] bg-primary-600 shrink-0 [&>svg]:w-full [&>svg]:h-full"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: markWhite }}
          />
          <div className="leading-tight whitespace-nowrap group-data-[state=collapsed]:hidden">
            <div className="font-semibold text-sm text-sidebar-accent-foreground">pg-boss</div>
            <div className="font-mono text-[9px] tracking-[0.15em] text-sidebar-foreground/60">CONSOLE</div>
          </div>
        </div>
        {databases && currentDb && databases.length > 1 && (
          <div className="group-data-[state=collapsed]:hidden">
            <DatabaseSelector
              databases={databases}
              currentDb={currentDb}
              onSelect={handleDatabaseSelect}
            />
          </div>
        )}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => (
                <NavItem
                  key={item.name}
                  item={item}
                  href={buildHref(item.href)}
                  onNavigate={() => setOpenMobile(false)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <ProSlot name="sidebarFooter" />
        <div className="flex flex-col px-2">
          <p className="px-2 mb-1 text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider group-data-[state=collapsed]:hidden">Theme</p>
          <ThemeToggle />
          <ColorThemePicker />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
