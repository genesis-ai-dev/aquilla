import type { SortingState } from "@tanstack/react-table"
import { Button } from "@/components/ui/button"

/** Controlled search, sort, and paging for an admin table backed by the server. */
export interface AdminTableServer {
  total: number
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  search: string
  onSearchChange: (value: string) => void
  searching?: boolean
  loading?: boolean
  onSortingChange?: (sorting: SortingState) => void
}

/**
 * "2 orgs" when the first page is the whole result, otherwise "1–50 of 80".
 * Previous and Next appear only when another page exists.
 */
export function AdminDirectoryPager({
  page,
  pageSize,
  total,
  onPageChange,
  noun,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  noun?: string
}) {
  const start = total === 0 ? 0 : page * pageSize + 1
  const end = Math.min(total, page * pageSize + pageSize)
  const wholeFirstPage = page === 0 && end === total
  const count = wholeFirstPage
    ? noun
      ? `${total} ${noun}`
      : `${total}`
    : noun
      ? `${start}–${end} of ${total} ${noun}`
      : `${start}–${end} of ${total}`
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  return (
    <span className="ml-auto flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
      <span>{count}</span>
      {total > pageSize && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 0}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page + 1 >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </>
      )}
    </span>
  )
}
