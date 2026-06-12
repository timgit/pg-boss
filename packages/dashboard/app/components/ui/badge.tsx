import { cva, type VariantProps } from 'class-variance-authority'
import { type ReactNode } from 'react'
import { cn } from '~/lib/utils'

// Variants map onto the pg-boss job-lifecycle palette (--state-*), which is
// theme-aware (solid tints in light, translucent on dark), so the same five
// variants render correctly in both modes without per-mode classes.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full font-medium',
  {
    variants: {
      variant: {
        gray: 'bg-[var(--state-created-bg)] text-[var(--state-created-fg)]',
        primary: 'bg-[var(--state-active-bg)] text-[var(--state-active-fg)]',
        success: 'bg-[var(--state-completed-bg)] text-[var(--state-completed-fg)]',
        warning: 'bg-[var(--state-retry-bg)] text-[var(--state-retry-fg)]',
        error: 'bg-[var(--state-failed-bg)] text-[var(--state-failed-fg)]',
      },
      size: {
        sm: 'px-2 py-0.5 text-[11px]',
        md: 'px-2.5 py-1 text-xs',
        lg: 'px-3 py-1 text-sm',
      },
    },
    defaultVariants: {
      variant: 'gray',
      size: 'md',
    },
  }
)

const dotVariants: Record<NonNullable<VariantProps<typeof badgeVariants>['variant']>, string> = {
  gray: 'bg-[var(--state-created-dot)]',
  primary: 'bg-[var(--state-active-dot)]',
  success: 'bg-[var(--state-completed-dot)]',
  warning: 'bg-[var(--state-retry-dot)]',
  error: 'bg-[var(--state-failed-dot)]',
}

interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode
  dot?: boolean
  className?: string
}

export function Badge ({
  children,
  variant = 'gray',
  size,
  dot = false,
  className,
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size, className }))}>
      {dot && (
        <span className={cn('h-1.5 w-1.5 rounded-full', dotVariants[variant ?? 'gray'])} />
      )}
      {children}
    </span>
  )
}
