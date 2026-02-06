import { Menu } from '@base-ui/react/menu'
import { Check, ChevronRight, Circle } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '~/lib/utils'

const DropdownMenu = Menu.Root

const DropdownMenuTrigger = Menu.Trigger

const DropdownMenuGroup = Menu.Group

const DropdownMenuPortal = Menu.Portal

const DropdownMenuSub = Menu.SubmenuTrigger

const DropdownMenuRadioGroup = Menu.RadioGroup

const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof Menu.SubmenuTrigger>,
  ComponentPropsWithoutRef<typeof Menu.SubmenuTrigger> & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <Menu.SubmenuTrigger
    ref={ref}
    className={cn(
      'flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none',
      'focus:bg-gray-100 dark:focus:bg-gray-800',
      'data-open:bg-gray-100 dark:data-open:bg-gray-800',
      inset && 'pl-8',
      className
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </Menu.SubmenuTrigger>
))
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger'

const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof Menu.Popup>,
  ComponentPropsWithoutRef<typeof Menu.Popup>
>(({ className, ...props }, ref) => (
  <Menu.Portal>
    <Menu.Positioner>
      <Menu.Popup
        ref={ref}
        className={cn(
          'z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg',
          'bg-white border-gray-200',
          'dark:bg-gray-900 dark:border-gray-800',
          'data-open:animate-in data-closed:animate-out',
          'data-closed:fade-out-0 data-open:fade-in-0',
          'data-closed:zoom-out-95 data-open:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
          'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className
        )}
        {...props}
      />
    </Menu.Positioner>
  </Menu.Portal>
))
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent'

const DropdownMenuContent = forwardRef<
  ElementRef<typeof Menu.Popup>,
  ComponentPropsWithoutRef<typeof Menu.Popup>
>(({ className, ...props }, ref) => (
  <Menu.Portal>
    <Menu.Positioner>
      <Menu.Popup
        ref={ref}
        className={cn(
          'z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-md',
          'bg-white border-gray-200 text-gray-900',
          'dark:bg-gray-900 dark:border-gray-800 dark:text-gray-100',
          'data-open:animate-in data-closed:animate-out',
          'data-closed:fade-out-0 data-open:fade-in-0',
          'data-closed:zoom-out-95 data-open:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
          'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className
        )}
        {...props}
      />
    </Menu.Positioner>
  </Menu.Portal>
))
DropdownMenuContent.displayName = 'DropdownMenuContent'

const DropdownMenuItem = forwardRef<
  ElementRef<typeof Menu.Item>,
  ComponentPropsWithoutRef<typeof Menu.Item> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <Menu.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
      'data-highlighted:bg-gray-100 data-highlighted:text-gray-900',
      'dark:data-highlighted:bg-gray-800 dark:data-highlighted:text-gray-100',
      'data-disabled:pointer-events-none data-disabled:opacity-50',
      inset && 'pl-8',
      className
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof Menu.CheckboxItem>,
  ComponentPropsWithoutRef<typeof Menu.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <Menu.CheckboxItem
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors',
      'data-highlighted:bg-gray-100 data-highlighted:text-gray-900',
      'dark:data-highlighted:bg-gray-800 dark:data-highlighted:text-gray-100',
      'data-disabled:pointer-events-none data-disabled:opacity-50',
      className
    )}
    checked={checked}
    {...props}
  >
    <Menu.CheckboxItemIndicator className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <Check className="h-4 w-4" />
    </Menu.CheckboxItemIndicator>
    {children}
  </Menu.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem'

const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof Menu.RadioItem>,
  ComponentPropsWithoutRef<typeof Menu.RadioItem>
>(({ className, children, ...props }, ref) => (
  <Menu.RadioItem
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors',
      'data-highlighted:bg-gray-100 data-highlighted:text-gray-900',
      'dark:data-highlighted:bg-gray-800 dark:data-highlighted:text-gray-100',
      'data-disabled:pointer-events-none data-disabled:opacity-50',
      className
    )}
    {...props}
  >
    <Menu.RadioItemIndicator className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <Circle className="h-2 w-2 fill-current" />
    </Menu.RadioItemIndicator>
    {children}
  </Menu.RadioItem>
))
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem'

const DropdownMenuLabel = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'px-2 py-1.5 text-sm font-semibold',
      inset && 'pl-8',
      className
    )}
    {...props}
  />
))
DropdownMenuLabel.displayName = 'DropdownMenuLabel'

const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof Menu.Separator>,
  ComponentPropsWithoutRef<typeof Menu.Separator>
>(({ className, ...props }, ref) => (
  <Menu.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-gray-200 dark:bg-gray-800', className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn('ml-auto text-xs tracking-widest opacity-60', className)}
      {...props}
    />
  )
}
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut'

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
}
