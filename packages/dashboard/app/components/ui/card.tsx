import { type ReactNode, type HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  className?: string
}

interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  className?: string
}

interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children: ReactNode
  className?: string
}

interface CardDescriptionProps extends HTMLAttributes<HTMLParagraphElement> {
  children: ReactNode
  className?: string
}

interface CardContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  className?: string
}

export function Card ({ children, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'bg-white rounded-xl border border-gray-200 shadow-sm',
        'dark:bg-gray-900 dark:border-gray-800',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardHeader ({ children, className, ...props }: CardHeaderProps) {
  return (
    <div
      className={cn(
        'px-6 py-5 border-b border-gray-200 dark:border-gray-800',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardTitle ({ children, className, ...props }: CardTitleProps) {
  return (
    <h3
      className={cn(
        'text-lg font-semibold text-gray-900 dark:text-gray-100',
        className
      )}
      {...props}
    >
      {children}
    </h3>
  )
}

export function CardDescription ({
  children,
  className,
  ...props
}: CardDescriptionProps) {
  return (
    <p
      className={cn('mt-1 text-sm text-gray-500 dark:text-gray-400', className)}
      {...props}
    >
      {children}
    </p>
  )
}

export function CardContent ({ children, className, ...props }: CardContentProps) {
  return (
    <div className={cn('px-6 py-5', className)} {...props}>
      {children}
    </div>
  )
}
