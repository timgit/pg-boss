import { NavLink, useRouteLoaderData, useSearchParams, useNavigate } from 'react-router'
import { useState } from 'react'
import { ThemeToggle } from '~/components/ui/theme-toggle'
import { cn } from '~/lib/utils'
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

interface DatabaseConfig {
  id: string
  name: string
  url: string
  schema: string
}

interface RootLoaderData {
  databases: DatabaseConfig[]
  currentDb: DatabaseConfig
}

const navigation = [
  { name: 'Overview', href: '/', icon: HomeIcon },
  { name: 'Queues', href: '/queues', icon: QueueIcon },
  { name: 'Warnings', href: '/warnings', icon: WarningIcon },
]

function HomeIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
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

function WarningIcon ({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
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
  databases: DatabaseConfig[]
  currentDb: DatabaseConfig
  onSelect: (db: DatabaseConfig) => void
}) {
  const [isOpen, setIsOpen] = useState(false)

  if (databases.length <= 1) {
    return null
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <DatabaseIcon className="w-4 h-4 flex-shrink-0" />
          <span className="font-medium truncate">{currentDb.name}</span>
        </div>
        <ChevronIcon className={cn('w-4 h-4 flex-shrink-0 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          {/* Dropdown */}
          <div className={cn(
            'absolute left-0 right-0 mt-1 rounded-lg shadow-lg z-20 py-1',
            'bg-sidebar-accent border border-sidebar-border'
          )}>
            {databases.map((db) => (
              <button
                key={db.id}
                type="button"
                onClick={() => {
                  onSelect(db)
                  setIsOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
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
        </>
      )}
    </div>
  )
}

export function AppSidebar () {
  const rootData = useRouteLoaderData('root') as RootLoaderData | undefined
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()

  const databases = rootData?.databases || []
  const currentDb = rootData?.currentDb
  const dbParam = searchParams.get('db')

  const handleDatabaseSelect = (db: DatabaseConfig) => {
    const params = new URLSearchParams(searchParams)
    if (db.id === databases[0]?.id) {
      params.delete('db')
    } else {
      params.set('db', db.id)
    }
    const newSearch = params.toString()
    navigate({
      pathname: window.location.pathname,
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
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm">PG</span>
          </div>
          <span className="font-semibold text-sidebar-foreground group-data-[state=collapsed]:hidden">pg-boss</span>
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
                <SidebarMenuItem key={item.name}>
                  <SidebarMenuButton asChild>
                    <NavLink
                      to={buildHref(item.href)}
                      end={item.href === '/'}
                      onClick={() => setOpenMobile(false)}
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon className="h-5 w-5 flex-shrink-0" />
                          <span className="group-data-[state=collapsed]:hidden">{item.name}</span>
                        </>
                      )}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between px-2">
          <div className="group-data-[state=collapsed]:hidden">
            <p className="text-xs text-sidebar-foreground/70">pg-boss Dashboard</p>
            {currentDb && databases && databases.length > 1 && (
              <p className="text-xs text-sidebar-foreground/50 mt-1 truncate" title={currentDb.schema}>
                Schema: {currentDb.schema}
              </p>
            )}
          </div>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
