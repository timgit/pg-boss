import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { CheckIcon, MinusIcon } from 'lucide-react'
import { cn } from '~/lib/utils'

// Ported from shadcn/ui's Base UI checkbox, with the dashboard's color tokens in place of shadcn's
// and a minus for the indeterminate state.

/**
 * A checkbox drawn the same in both themes. Renders a `<span role="checkbox">` with a hidden input
 * beside it, so `name` posts with a form as a native checkbox does. Its target reaches past the box,
 * and `data-no-row-nav` keeps a click on it from opening a clickable table row.
 */
function Checkbox ({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-no-row-nav=""
      className={cn(
        'group relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface-card)] text-white shadow-xs outline-none transition-colors',
        'data-checked:border-[var(--primary-600)] data-checked:bg-[var(--primary-600)] data-indeterminate:border-[var(--primary-600)] data-indeterminate:bg-[var(--primary-600)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        // A larger target than the box, as shadcn draws it, so a near miss in a table ticks the box instead of opening the row.
        'after:absolute after:-inset-x-3 after:-inset-y-2',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center text-current">
        <CheckIcon className="size-3.5 group-data-indeterminate:hidden" strokeWidth={3} aria-hidden="true" />
        <MinusIcon className="hidden size-3.5 group-data-indeterminate:block" strokeWidth={3} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
