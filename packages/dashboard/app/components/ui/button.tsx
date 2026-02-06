import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes, type ReactElement } from 'react'
import { cn } from '~/lib/utils'
import { useRender, mergeProps } from '~/lib/use-render'

const buttonVariants = cva(
  'inline-flex items-center justify-center font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed dark:focus:ring-offset-gray-900',
  {
    variants: {
      variant: {
        primary:
          'bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-600 shadow-sm',
        secondary:
          'bg-primary-50 text-primary-700 hover:bg-primary-100 focus:ring-primary-600 dark:bg-primary-950 dark:text-primary-300 dark:hover:bg-primary-900',
        outline:
          'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:ring-primary-600 shadow-sm dark:bg-gray-900 dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-800',
        ghost:
          'text-gray-700 hover:bg-gray-100 focus:ring-primary-600 dark:text-gray-300 dark:hover:bg-gray-800',
        danger:
          'bg-red-600 text-white hover:bg-red-700 focus:ring-red-600 shadow-sm',
      },
      size: {
        sm: 'px-3 py-1.5 text-sm',
        md: 'px-4 py-2 text-sm',
        lg: 'px-5 py-2.5 text-base',
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
  // Backward compatibility with React Aria
  isDisabled?: boolean
  onPress?: () => void
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, render, isDisabled, onPress, onClick, disabled, ...props }, ref) => {
    // Support both isDisabled (React Aria) and disabled (native)
    const isButtonDisabled = isDisabled ?? disabled

    // Support both onPress (React Aria) and onClick (native)
    const handleClick = onPress ?? onClick

    return useRender({
      defaultTagName: 'button',
      render,
      props: mergeProps(
        {
          className: cn(buttonVariants({ variant, size, className })),
          disabled: isButtonDisabled,
          onClick: handleClick,
        },
        props
      ),
      ref,
    })
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
