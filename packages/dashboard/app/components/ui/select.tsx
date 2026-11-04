import type { ComponentProps } from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { cn } from '~/lib/utils'

// Ported from shadcn/ui's Base UI select, with the dashboard's color tokens in place of shadcn's.
// The popup and its items match the dashboard's menus and comboboxes: below the trigger, the check
// on the left.

/** A single choice from a list, drawn the same in both themes. `name` posts the value with a form. */
const Select = SelectPrimitive.Root

const SelectGroup = SelectPrimitive.Group

function SelectValue ({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn('truncate data-placeholder:text-[var(--text-tertiary)]', className)}
      {...props}
    />
  )
}

const TRIGGER_SIZE = {
  default: 'h-[38px] px-3 text-sm',
  sm: 'h-[34px] px-2.5 text-sm',
  xs: 'h-7 px-2 text-xs',
}

const TRIGGER_VARIANT = {
  // Beside the filter bars' search fields.
  filter: 'rounded-lg border-[var(--border-strong)] shadow-sm',
  // Among a form's text fields.
  field: 'w-full rounded-md border-[var(--border-default)]',
}

/** The closed select. `variant` matches the fields beside it, a filter bar's or a form's, and defaults to `filter`. */
function SelectTrigger ({
  className,
  size = 'default',
  variant = 'filter',
  children,
  ...props
}: SelectPrimitive.Trigger.Props & { size?: keyof typeof TRIGGER_SIZE, variant?: keyof typeof TRIGGER_VARIANT }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'inline-flex min-w-0 cursor-pointer items-center justify-between gap-2 border bg-[var(--surface-card)] text-left whitespace-nowrap text-[var(--text-primary)] outline-none transition-colors',
        'focus-visible:border-[var(--border-focus)] focus-visible:shadow-[var(--shadow-focus)] data-popup-open:border-[var(--border-focus)]',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        TRIGGER_SIZE[size],
        TRIGGER_VARIANT[variant],
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon render={<ChevronDownIcon className="size-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />} />
    </SelectPrimitive.Trigger>
  )
}

/** The open list, below the trigger and at least as wide. */
function SelectContent ({
  className,
  children,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  ...props
}: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignItemWithTrigger={false} className="z-50 outline-none">
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'max-h-[min(var(--available-height),20rem)] min-w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--surface-card)] p-1 text-[var(--text-primary)] shadow-lg outline-none',
            'origin-[var(--transform-origin)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel ({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('px-2.5 py-1.5 text-xs font-medium text-[var(--text-tertiary)]', className)}
      {...props}
    />
  )
}

function SelectItem ({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'grid cursor-pointer grid-cols-[1rem_1fr] items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none select-none',
        'data-highlighted:bg-[var(--surface-hover)] data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="col-start-1 text-[var(--primary-600)] dark:text-[var(--primary-400)]">
        <CheckIcon className="size-4" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText className="col-start-2 truncate">{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator ({ className, ...props }: ComponentProps<'div'>) {
  return <div role="separator" data-slot="select-separator" className={cn('-mx-1 my-1 h-px bg-[var(--border-subtle)]', className)} {...props} />
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue }
