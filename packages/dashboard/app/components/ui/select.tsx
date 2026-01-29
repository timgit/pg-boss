import { Select } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '~/lib/utils'

const SelectRoot = Select.Root

const SelectGroup = Select.Group

const SelectValue = Select.Value

const SelectTrigger = forwardRef<
  ElementRef<typeof Select.Trigger>,
  ComponentPropsWithoutRef<typeof Select.Trigger>
>(({ className, children, ...props }, ref) => (
  <Select.Trigger
    ref={ref}
    className={cn(
      'flex items-center justify-between w-full px-3 py-2 text-sm rounded-lg shadow-sm',
      'bg-white border border-gray-300 text-gray-900',
      'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100',
      'hover:bg-gray-50 dark:hover:bg-gray-800',
      'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2',
      'dark:focus:ring-offset-gray-900',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'placeholder:text-gray-500 dark:placeholder:text-gray-400',
      '[&>span]:truncate [&>span]:text-left',
      className
    )}
    {...props}
  >
    {children}
    <Select.Icon>
      <ChevronDown className="h-4 w-4 opacity-50 ml-2 shrink-0" />
    </Select.Icon>
  </Select.Trigger>
))
SelectTrigger.displayName = 'SelectTrigger'

const SelectContent = forwardRef<
  ElementRef<typeof Select.Popup>,
  ComponentPropsWithoutRef<typeof Select.Popup>
>(({ className, children, ...props }, ref) => (
  <Select.Portal>
    <Select.Positioner>
      <Select.Popup
        ref={ref}
        className={cn(
          'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-lg border shadow-lg',
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
      >
        <Select.List className="p-1">
          {children}
        </Select.List>
      </Select.Popup>
    </Select.Positioner>
  </Select.Portal>
))
SelectContent.displayName = 'SelectContent'

const SelectLabel = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('py-1.5 pl-8 pr-2 text-sm font-semibold', className)}
    {...props}
  />
))
SelectLabel.displayName = 'SelectLabel'

const SelectItem = forwardRef<
  ElementRef<typeof Select.Item>,
  ComponentPropsWithoutRef<typeof Select.Item>
>(({ className, children, ...props }, ref) => (
  <Select.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center rounded-sm py-2 pl-8 pr-2 text-sm outline-none',
      'text-gray-900 dark:text-gray-100',
      'data-highlighted:bg-primary-50 data-highlighted:text-primary-900',
      'dark:data-highlighted:bg-primary-950 dark:data-highlighted:text-primary-100',
      'data-disabled:pointer-events-none data-disabled:opacity-50',
      className
    )}
    {...props}
  >
    <Select.ItemIndicator className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <Check className="h-4 w-4" />
    </Select.ItemIndicator>
    <Select.ItemText>{children}</Select.ItemText>
  </Select.Item>
))
SelectItem.displayName = 'SelectItem'

const SelectSeparator = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-gray-200 dark:bg-gray-800', className)}
    {...props}
  />
))
SelectSeparator.displayName = 'SelectSeparator'

export {
  SelectRoot as Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
}
