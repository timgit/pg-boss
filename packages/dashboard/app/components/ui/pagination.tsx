import type { ComponentProps, ReactNode } from 'react'
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react'
import { Button } from './button'
import { DbLink } from '~/components/db-link'
import { cn } from '~/lib/utils'

// Ported from shadcn/ui's Base UI pagination. The links are the dashboard's own Button rendered as
// a DbLink, so page changes stay client-side and keep the base path and the selected database.

function Pagination ({ className, ...props }: ComponentProps<'nav'>) {
  return (
    <nav
      role="navigation"
      aria-label="pagination"
      data-slot="pagination"
      className={cn('mx-auto flex w-full justify-center', className)}
      {...props}
    />
  )
}

function PaginationContent ({ className, ...props }: ComponentProps<'ul'>) {
  return <ul data-slot="pagination-content" className={cn('flex items-center gap-1', className)} {...props} />
}

function PaginationItem (props: ComponentProps<'li'>) {
  return <li data-slot="pagination-item" {...props} />
}

interface PaginationLinkProps {
  /** Where the link goes; omitted, it renders as a disabled control rather than a link. */
  to?: string
  isActive?: boolean
  size?: 'icon' | 'sm' | 'md'
  className?: string
  children: ReactNode
  'aria-label'?: string
}

function PaginationLink ({ to, isActive, size = 'icon', className, children, ...props }: PaginationLinkProps) {
  const disabled = to === undefined

  return (
    <Button
      variant={isActive ? 'outline' : 'ghost'}
      size={size}
      className={cn(disabled && 'pointer-events-none opacity-50', className)}
      render={disabled
        ? <span aria-disabled="true" data-slot="pagination-link" />
        : (
          <DbLink
            to={to}
            aria-current={isActive ? 'page' : undefined}
            data-slot="pagination-link"
            data-active={isActive ? 'true' : undefined}
          />
          )}
      {...props}
    >
      {children}
    </Button>
  )
}

function PaginationPrevious ({ className, ...props }: Omit<PaginationLinkProps, 'children'>) {
  return (
    <PaginationLink aria-label="Go to previous page" size="md" className={cn('gap-1 px-2.5 sm:pl-2.5', className)} {...props}>
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:block">Previous</span>
    </PaginationLink>
  )
}

function PaginationNext ({ className, ...props }: Omit<PaginationLinkProps, 'children'>) {
  return (
    <PaginationLink aria-label="Go to next page" size="md" className={cn('gap-1 px-2.5 sm:pr-2.5', className)} {...props}>
      <span className="hidden sm:block">Next</span>
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </PaginationLink>
  )
}

function PaginationEllipsis ({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn('flex h-9 w-9 items-center justify-center', className)}
      {...props}
    >
      <MoreHorizontal className="h-4 w-4" />
      <span className="sr-only">More pages</span>
    </span>
  )
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
}
