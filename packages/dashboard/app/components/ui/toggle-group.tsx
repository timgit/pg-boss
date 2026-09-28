import type { ComponentProps } from 'react'
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import { cn } from '~/lib/utils'

// Ported from shadcn/ui's Base UI toggle group, drawn as a segmented control: a sunken track with
// the pressed item raised onto a card. Single-select unless `multiple` is set, as in Base UI.

function ToggleGroup ({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg bg-[var(--surface-sunken)] p-[3px]',
        className
      )}
      {...props}
    />
  )
}

function ToggleGroupItem ({ className, ...props }: ComponentProps<typeof TogglePrimitive>) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        'h-7 cursor-pointer rounded-md px-3 text-[13px] text-[var(--text-secondary)] transition-colors',
        'hover:text-[var(--text-primary)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
        'data-[pressed]:bg-[var(--surface-card)] data-[pressed]:font-medium data-[pressed]:text-[var(--text-primary)] data-[pressed]:shadow-sm',
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
