import { cva, type VariantProps } from 'class-variance-authority'
import { type ReactNode } from 'react'
import { cn } from '~/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset',
  {
    variants: {
      variant: {
        gray: 'bg-gray-100 text-gray-700 ring-gray-500/10 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-500/20',
        primary: 'bg-primary-50 text-primary-700 ring-primary-600/10 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-500/20',
        success: 'bg-success-50 text-success-700 ring-success-600/10 dark:bg-success-950 dark:text-success-300 dark:ring-success-400/20',
        warning: 'bg-warning-50 text-warning-700 ring-warning-600/10 dark:bg-warning-950 dark:text-warning-300 dark:ring-warning-400/20',
        error: 'bg-error-50 text-error-700 ring-error-600/10 dark:bg-error-950 dark:text-error-300 dark:ring-error-400/20',
      },
      size: {
        sm: 'px-2 py-0.5 text-xs',
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
  gray: 'bg-gray-500',
  primary: 'bg-primary-500 dark:bg-gray-400',
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  error: 'bg-error-500',
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
