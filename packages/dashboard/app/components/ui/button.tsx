import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes, type ReactElement } from 'react'
import { useRender, mergeProps } from '@base-ui/react'
import { cn } from '~/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center font-semibold rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed dark:focus-visible:ring-offset-gray-900',
  {
    variants: {
      variant: {
        primary:
          'bg-primary-600 text-white hover:bg-primary-700 focus-visible:ring-primary-600 shadow-sm',
        secondary:
          'bg-primary-50 text-primary-700 hover:bg-primary-100 focus-visible:ring-primary-600 dark:bg-primary-950 dark:text-primary-300 dark:hover:bg-primary-900',
        outline:
          'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus-visible:ring-primary-600 shadow-sm dark:bg-gray-900 dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-800',
        ghost:
          'text-gray-700 hover:bg-gray-100 focus-visible:ring-primary-600 dark:text-gray-300 dark:hover:bg-gray-800',
        danger:
          'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600 shadow-sm',
      },
      size: {
        sm: 'px-3 py-1.5 text-sm',
        md: 'px-4 py-2 text-sm',
        lg: 'px-5 py-2.5 text-base',
        // Square, for a control that is only an icon or a short label such as a page number.
        icon: 'h-9 w-9 p-0 text-sm',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  render?: ReactElement
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, render, ...props }, ref) => {
    return useRender({
      defaultTagName: 'button',
      render,
      props: mergeProps(
        {
          className: cn(buttonVariants({ variant, size, className })),
        },
        props
      ),
      ref,
    })
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
