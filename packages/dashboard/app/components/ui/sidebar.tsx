import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { PanelLeft } from 'lucide-react'
import { useRender, mergeProps } from '@base-ui/react'
import { cn } from '~/lib/utils'
import { Tooltip } from '~/components/ui/tooltip'

const SIDEBAR_COOKIE_NAME = 'sidebar:state'
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days
const SIDEBAR_WIDTH = '16rem'
const SIDEBAR_WIDTH_MOBILE = '18rem'
const SIDEBAR_WIDTH_ICON = '3rem'
const SIDEBAR_KEYBOARD_SHORTCUT = 'b'

type SidebarContext = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContext | null>(null)

function useSidebar () {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }
  return context
}

interface SidebarProviderProps extends React.ComponentProps<'div'> {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const SidebarProvider = React.forwardRef<HTMLDivElement, SidebarProviderProps>(
  ({ defaultOpen = true, open: openProp, onOpenChange: setOpenProp, className, style, children, ...props }, ref) => {
    const [openMobile, setOpenMobile] = React.useState(false)
    const [_open, _setOpen] = React.useState(defaultOpen)
    const open = openProp ?? _open
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === 'function' ? value(open) : value
        if (setOpenProp) {
          setOpenProp(openState)
        } else {
          _setOpen(openState)
        }
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
      },
      [setOpenProp, open]
    )

    const toggleSidebar = React.useCallback(() => {
      return setOpen((open) => !open)
    }, [setOpen])

    const [isMobile, setIsMobile] = React.useState(false)

    React.useEffect(() => {
      const mql = window.matchMedia('(max-width: 768px)')
      const onChange = () => setIsMobile(mql.matches)
      onChange()
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }, [])

    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          toggleSidebar()
        }
      }
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }, [toggleSidebar])

    const state = open ? 'expanded' : 'collapsed'

    const contextValue = React.useMemo<SidebarContext>(
      () => ({
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        setOpenMobile,
        toggleSidebar,
      }),
      [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
    )

    return (
      <SidebarContext.Provider value={contextValue}>
        <div
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper flex min-h-screen w-full has-[[data-variant=inset]]:bg-sidebar',
            className
          )}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      </SidebarContext.Provider>
    )
  }
)
SidebarProvider.displayName = 'SidebarProvider'

const Sidebar = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'> & {
  side?: 'left' | 'right'
  variant?: 'sidebar' | 'floating' | 'inset'
  collapsible?: 'offcanvas' | 'icon' | 'none'
}>(
  ({ side = 'left', variant = 'sidebar', collapsible = 'offcanvas', className, children, ...props }, ref) => {
    const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

    if (collapsible === 'none') {
      return (
        <div
          className={cn('flex h-full w-[--sidebar-width] flex-col bg-sidebar text-sidebar-foreground', className)}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      )
    }

    if (isMobile) {
      return (
        <>
          {openMobile && (
            <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setOpenMobile(false)} />
          )}
          <div
            ref={ref}
            className={cn(
              'fixed inset-y-0 z-50 flex h-full w-[--sidebar-width-mobile] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 ease-in-out',
              side === 'left' ? 'left-0' : 'right-0',
              openMobile ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full',
              className
            )}
            {...props}
          >
            {children}
          </div>
        </>
      )
    }

    return (
      <div
        ref={ref}
        data-state={state}
        className={cn(
          'group peer hidden md:flex fixed inset-y-0 left-0 z-30 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground overflow-y-auto overflow-x-hidden',
          'transition-[width] duration-200 ease-linear',
          state === 'expanded' ? 'w-[--sidebar-width]' : 'w-[--sidebar-width-icon]',
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }
)
Sidebar.displayName = 'Sidebar'

const SidebarTrigger = React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'>>(
  ({ className, onClick, ...props }, ref) => {
    const { toggleSidebar, isMobile, openMobile, setOpenMobile } = useSidebar()

    return (
      <button
        ref={ref}
        onClick={(event) => {
          onClick?.(event)
          if (isMobile) {
            setOpenMobile(!openMobile)
          } else {
            toggleSidebar()
          }
        }}
        className={cn(
          'inline-flex items-center justify-center rounded-md p-2 cursor-pointer',
          'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          className
        )}
        {...props}
      >
        <PanelLeft className="h-5 w-5" />
        <span className="sr-only">Toggle Sidebar</span>
      </button>
    )
  }
)
SidebarTrigger.displayName = 'SidebarTrigger'

const SidebarHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn('flex flex-col gap-2 p-2 overflow-hidden', className)} {...props} />
  }
)
SidebarHeader.displayName = 'SidebarHeader'

const SidebarFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn('flex flex-col gap-2 p-2 overflow-hidden', className)} {...props} />
  }
)
SidebarFooter.displayName = 'SidebarFooter'

const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-auto', className)}
        {...props}
      />
    )
  }
)
SidebarContent.displayName = 'SidebarContent'

const SidebarGroup = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn('relative flex w-full min-w-0 flex-col p-2', className)} {...props} />
  }
)
SidebarGroup.displayName = 'SidebarGroup'

const SidebarGroupLabel = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('px-2 text-xs font-medium text-sidebar-foreground/70', className)}
        {...props}
      />
    )
  }
)
SidebarGroupLabel.displayName = 'SidebarGroupLabel'

const SidebarGroupContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn('w-full text-sm', className)} {...props} />
  }
)
SidebarGroupContent.displayName = 'SidebarGroupContent'

const SidebarMenu = React.forwardRef<HTMLUListElement, React.ComponentProps<'ul'>>(
  ({ className, ...props }, ref) => {
    return <ul ref={ref} className={cn('flex w-full min-w-0 flex-col gap-1', className)} {...props} />
  }
)
SidebarMenu.displayName = 'SidebarMenu'

const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.ComponentProps<'li'>>(
  ({ className, ...props }, ref) => {
    return <li ref={ref} className={cn('group/menu-item relative', className)} {...props} />
  }
)
SidebarMenuItem.displayName = 'SidebarMenuItem'

const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 cursor-pointer group-has-[[data-sidebar=menu-action]]/menu-item:pr-8 group-data-[state=collapsed]:justify-center',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline: 'bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[state=collapsed]:!h-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    render?: React.ReactElement
    isActive?: boolean
    tooltip?: string | React.ComponentProps<'div'>
  } & VariantProps<typeof sidebarMenuButtonVariants>
>(({ render, isActive = false, variant = 'default', size = 'default', tooltip, className, ...props }, ref) => {
  const { state } = useSidebar()

  const button = useRender({
    defaultTagName: 'button',
    render,
    props: mergeProps(
      {
        'data-sidebar': 'menu-button',
        'data-active': isActive,
        className: cn(
          sidebarMenuButtonVariants({ variant, size }),
          isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
          className
        ),
      },
      props
    ),
    ref,
  })

  // Show tooltip only when sidebar is collapsed and tooltip is provided
  if (state === 'collapsed' && tooltip && typeof tooltip === 'string') {
    return <Tooltip content={tooltip}>{button}</Tooltip>
  }

  return button
})
SidebarMenuButton.displayName = 'SidebarMenuButton'

const SidebarMenuAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    render?: React.ReactElement
    showOnHover?: boolean
  }
>(({ className, render, showOnHover = false, ...props }, ref) => {
  return useRender({
    defaultTagName: 'button',
    render,
    props: mergeProps(
      {
        'data-sidebar': 'menu-action',
        className: cn(
          'absolute right-1 top-1.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-none ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
          'after:absolute after:-inset-2 after:md:hidden',
          'peer-hover/menu-button:text-sidebar-accent-foreground',
          showOnHover &&
            'peer-data-[active=true]/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0',
          className
        ),
      },
      props
    ),
    ref,
  })
})
SidebarMenuAction.displayName = 'SidebarMenuAction'

const SidebarMenuSub = React.forwardRef<HTMLUListElement, React.ComponentProps<'ul'>>(
  ({ className, ...props }, ref) => {
    return (
      <ul
        ref={ref}
        data-sidebar="menu-sub"
        className={cn('mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5', className)}
        {...props}
      />
    )
  }
)
SidebarMenuSub.displayName = 'SidebarMenuSub'

const SidebarMenuSubItem = React.forwardRef<HTMLLIElement, React.ComponentProps<'li'>>(
  ({ ...props }, ref) => {
    return <li ref={ref} {...props} />
  }
)
SidebarMenuSubItem.displayName = 'SidebarMenuSubItem'

const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<'a'> & {
    render?: React.ReactElement
    size?: 'sm' | 'md'
    isActive?: boolean
  }
>(({ render, size = 'md', isActive, className, ...props }, ref) => {
  return useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps(
      {
        'data-sidebar': 'menu-sub-button',
        'data-size': size,
        'data-active': isActive,
        className: cn(
          'flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
          'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
          size === 'sm' && 'text-xs',
          size === 'md' && 'text-sm',
          className
        ),
      },
      props
    ),
    ref,
  })
})
SidebarMenuSubButton.displayName = 'SidebarMenuSubButton'

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
}
