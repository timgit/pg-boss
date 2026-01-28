import { Button } from './button'
import { cn } from '~/lib/utils'

interface PaginationProps {
  page: number
  totalPages?: number | null
  hasNextPage: boolean
  hasPrevPage: boolean
  onPageChange: (page: number) => void
}

export function Pagination ({
  page,
  totalPages,
  hasNextPage,
  hasPrevPage,
  onPageChange,
}: PaginationProps) {
  if (!hasPrevPage && !hasNextPage) {
    return null
  }

  return (
    <div
      className={cn(
        'flex items-center justify-between px-6 py-4 border-t',
        'border-gray-200 dark:border-gray-800'
      )}
    >
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Page {page}
        {totalPages != null && ` of ${totalPages}`}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={!hasPrevPage}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNextPage}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
