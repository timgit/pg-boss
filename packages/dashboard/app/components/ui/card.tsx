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

export function Card ({ children, className, style, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[10px] border border-[var(--border-default)] shadow-sm overflow-hidden',
        className
      )}
      style={{ background: 'var(--surface-card-grad)', ...style }}
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
        'flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border-subtle)]',
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
        'text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]',
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
      className={cn('mt-1 text-sm text-[var(--text-tertiary)]', className)}
      {...props}
    >
      {children}
    </p>
  )
}

export function CardContent ({ children, className, ...props }: CardContentProps) {
  return (
    <div className={cn('px-5 py-5', className)} {...props}>
      {children}
    </div>
  )
}
