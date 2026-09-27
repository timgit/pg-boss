import { useLocation } from 'react-router'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '~/components/ui/pagination'
import { pagingSearchParams, type PagePosition } from '~/lib/utils'

interface TablePaginationProps extends PagePosition {
  /** Null when the total is not known, which leaves no ellipsis after the next page. */
  totalPages: number | null
  hasPrevPage: boolean
  hasNextPage: boolean
  /** With `pageSize`, labels the rows on screen: "51–100 of 312". */
  totalCount?: number | null
  pageSize?: number
}

type Slot = number | 'gap'

/**
 * The pages to offer. A keyset cursor reaches only the first page and the pages either side of
 * this one, so those are the links, with gaps where pages are skipped.
 */
export function pageSlots (page: number, hasNextPage: boolean, totalPages: number | null): Slot[] {
  const slots: Slot[] = []

  if (page > 1) slots.push(1)
  if (page > 3) slots.push('gap')
  if (page > 2) slots.push(page - 1)
  slots.push(page)
  if (hasNextPage) slots.push(page + 1)
  if (hasNextPage && totalPages != null && totalPages > page + 1) slots.push('gap')

  return slots
}

/**
 * "51–100 of 312". A page past the end (a stale bookmark, rows deleted since) holds
 * none of them: the routes count alongside the page query rather than before it, so
 * they cannot clamp, and the label says so plainly with the first page one link away.
 */
export function rangeLabel (page: number, pageSize: number, totalCount: number): string {
  const first = (page - 1) * pageSize + 1
  const total = totalCount.toLocaleString()

  return first > totalCount
    ? `0 of ${total}`
    : `${first.toLocaleString()}–${Math.min(page * pageSize, totalCount).toLocaleString()} of ${total}`
}

/** Previous, numbered pages and Next under a table, as links that keep the rest of the URL. Nothing for a single page. */
export function TablePagination ({ page, nextCursor, prevCursor, totalPages, hasPrevPage, hasNextPage, totalCount, pageSize }: TablePaginationProps) {
  const { pathname, search } = useLocation()

  if (!hasPrevPage && !hasNextPage) {
    return null
  }

  const hrefFor = (target: number) => {
    const query = pagingSearchParams(new URLSearchParams(search), target, { page, nextCursor, prevCursor }).toString()
    return query ? `${pathname}?${query}` : pathname
  }

  const slots = pageSlots(page, hasNextPage, totalPages)
  const range = totalCount != null && pageSize ? rangeLabel(page, pageSize, totalCount) : null

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-[var(--border-subtle)]">
      <div className="pgb-num text-sm text-[var(--text-tertiary)]">{range}</div>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious to={hasPrevPage ? hrefFor(page - 1) : undefined} />
          </PaginationItem>
          {slots.map((slot, index) => (
            <PaginationItem key={slot === 'gap' ? `gap-${index}` : slot}>
              {slot === 'gap'
                ? <PaginationEllipsis />
                : <PaginationLink to={hrefFor(slot)} isActive={slot === page}>{slot.toLocaleString()}</PaginationLink>}
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext to={hasNextPage ? hrefFor(page + 1) : undefined} />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
