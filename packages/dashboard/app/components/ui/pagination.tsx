import { Button } from "./button";

interface PaginationProps {
  page: number;
  totalPages?: number | null;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  onPageChange: (page: number) => void;
}

export function Pagination({
  page,
  totalPages,
  hasNextPage,
  hasPrevPage,
  onPageChange,
}: PaginationProps) {
  if (!hasPrevPage && !hasNextPage) {
    return null;
  }

  return (
    <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200">
      <div className="text-sm text-gray-500">
        Page {page}
        {totalPages != null && ` of ${totalPages}`}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onPress={() => onPageChange(page - 1)}
          isDisabled={!hasPrevPage}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={() => onPageChange(page + 1)}
          isDisabled={!hasNextPage}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
