import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { EmptyState } from "@/components/ui/page"
import { cn } from "@/lib/utils"

/**
 * The one list primitive the admin console renders every table through, so no
 * tab re-implements search / sort / empty-state / numeric alignment by hand.
 *
 * - Free-text search (when `searchText` is given) filters client-side.
 * - Columns opt into sorting via `sortValue`; the header toggles asc/desc.
 * - `align: "right"` gives a column `tabular-nums` so figures line up.
 * - Zero rows → the caller's `<EmptyState>`; a search that matches nothing →
 *   a lightweight "no matches" note that keeps the search box in place.
 *
 * Presentation only — callers own the data; this never fetches.
 */
export interface AdminColumn<T> {
  key: string
  header: React.ReactNode
  render: (row: T) => React.ReactNode
  /** Return a comparable value to make the column sortable (omit = not sortable). */
  sortValue?: (row: T) => string | number | null
  align?: "left" | "right"
  /** Extra classes on the <td> (e.g. a highlighted rail). */
  cellClassName?: string
  headerClassName?: string
}

interface EmptyProps {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
}

export interface AdminDataTableProps<T> {
  columns: AdminColumn<T>[]
  rows: T[]
  getRowKey: (row: T) => string | number
  empty: EmptyProps
  /** When provided, renders a search box filtering on this row → text projection. */
  searchText?: (row: T) => string
  searchPlaceholder?: string
  /** Whole-row click (keyboard-accessible). In-cell links/buttons should stopPropagation. */
  onRowClick?: (row: T) => void
  initialSort?: { key: string; dir: SortDir }
  /** Extra controls rendered on the right of the toolbar (e.g. a lens select). */
  toolbar?: React.ReactNode
  testId?: string
}

type SortDir = "asc" | "desc"

function compare(a: string | number | null, b: string | number | null): number {
  // Nulls sort last regardless of direction (handled by the caller flipping sign).
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b))
}

export function AdminDataTable<T>({
  columns,
  rows,
  getRowKey,
  empty,
  searchText,
  searchPlaceholder = "Search…",
  onRowClick,
  initialSort,
  toolbar,
  testId,
}: AdminDataTableProps<T>) {
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initialSort ?? null)

  const filtered = useMemo(() => {
    if (!searchText || query.trim() === "") return rows
    const q = query.trim().toLowerCase()
    return rows.filter((r) => searchText(r).toLowerCase().includes(q))
  }, [rows, query, searchText])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return filtered
    const dir = sort.dir === "asc" ? 1 : -1
    // Nulls-last independent of dir: compare() already returns +1 for a null `a`.
    return [...filtered].sort((x, y) => {
      const cmp = compare(col.sortValue!(x), col.sortValue!(y))
      return cmp === 0 ? 0 : cmp * dir
    })
  }, [filtered, sort, columns])

  const toggleSort = (key: string) => {
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    )
  }

  if (rows.length === 0) {
    return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
  }

  return (
    <div className="space-y-3">
      {(searchText || toolbar) && (
        <div className="flex flex-wrap items-center gap-3">
          {searchText && (
            <InputGroup className="min-w-0 flex-1 sm:max-w-xs">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
            </InputGroup>
          )}
          {toolbar}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {sorted.length === rows.length ? `${rows.length}` : `${sorted.length} of ${rows.length}`}
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full text-sm" data-testid={testId}>
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              {columns.map((col) => {
                const sortable = Boolean(col.sortValue)
                const activeSort = sort?.key === col.key
                return (
                  <th
                    key={col.key}
                    className={cn(
                      "sticky top-0 z-10 bg-muted/40 px-3 py-2 font-medium",
                      col.align === "right" && "text-right",
                      col.headerClassName,
                    )}
                    aria-sort={activeSort ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className={cn(
                          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
                          col.align === "right" && "flex-row-reverse",
                          activeSort && "text-foreground",
                        )}
                      >
                        {col.header}
                        {activeSort ? (
                          sort!.dir === "asc" ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No matches for “{query}”.
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr
                  key={getRowKey(row)}
                  className={cn(
                    "border-t transition-colors hover:bg-muted/30",
                    onRowClick && "cursor-pointer",
                  )}
                  {...(onRowClick
                    ? {
                        role: "button",
                        tabIndex: 0,
                        onClick: () => onRowClick(row),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            onRowClick(row)
                          }
                        },
                      }
                    : {})}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-2 align-middle",
                        col.align === "right" && "text-right tabular-nums",
                        col.cellClassName,
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
