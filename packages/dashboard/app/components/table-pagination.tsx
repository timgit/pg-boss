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

interface TablePaginationProps {
  page: number
  /** Null when the total is not known, which leaves only Previous, the current page and Next. */
  totalPages: number | null
  hasPrevPage: boolean
  hasNextPage: boolean
  /** With `pageSize`, labels the rows on screen: "51–100 of 312". */
  totalCount?: number | null
  pageSize?: number
}

type Slot = number | 'gap'

/** The pages to offer: the first, the last, the current one and its neighbours, with gaps between. */
export function pageSlots (page: number, totalPages: number): Slot[] {
  const wanted = [1, page - 1, page, page + 1, totalPages].filter((n) => n >= 1 && n <= totalPages)
  const pages = [...new Set(wanted)].sort((a, b) => a - b)
  const slots: Slot[] = []

  for (const [index, n] of pages.entries()) {
    const previous = pages[index - 1]

    if (previous !== undefined && n - previous === 2) {
      // A gap of one page is shown as that page; an ellipsis would take the same room.
      slots.push(previous + 1)
    } else if (previous !== undefined && n - previous > 2) {
      slots.push('gap')
    }

    slots.push(n)
  }

  return slots
}

/**
 * "51–100 of 312". A page past the end (a stale bookmark, rows deleted since) holds
 * none of them: the routes count alongside the page query rather than before it, so
 * they cannot clamp, and the label says so plainly with the last page one link away.
 */
export function rangeLabel (page: number, pageSize: number, totalCount: number): string {
  const first = (page - 1) * pageSize + 1
  const total = totalCount.toLocaleString()

  return first > totalCount
    ? `0 of ${total}`
    : `${first.toLocaleString()}–${Math.min(page * pageSize, totalCount).toLocaleString()} of ${total}`
}

/** Previous, numbered pages and Next under a table, as links that keep the rest of the URL. Nothing for a single page. */
export function TablePagination ({ page, totalPages, hasPrevPage, hasNextPage, totalCount, pageSize }: TablePaginationProps) {
  const { pathname, search } = useLocation()

  if (!hasPrevPage && !hasNextPage) {
    return null
  }

  const hrefFor = (target: number) => {
    const params = new URLSearchParams(search)
    if (target > 1) {
      params.set('page', String(target))
    } else {
      params.delete('page')
    }
    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
  }

  const slots: Slot[] = totalPages != null ? pageSlots(page, totalPages) : [page]
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
