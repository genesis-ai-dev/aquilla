import type { SortingState } from "@tanstack/react-table"

/**
 * Controlled search and sort for an admin table whose rows grow as it scrolls.
 * The server still applies the query to the whole directory.
 */
export interface AdminTableServer {
  total: number
  search: string
  onSearchChange: (value: string) => void
  searching?: boolean
  loading?: boolean
  loadingMore?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  onSortingChange?: (sorting: SortingState) => void
}

/** The full match count. Further rows arrive by scrolling, not by a page button. */
export function AdminDirectoryCount({ total, noun }: { total: number; noun?: string }) {
  return (
    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
      {noun ? `${total} ${noun}` : `${total}`}
    </span>
  )
}
