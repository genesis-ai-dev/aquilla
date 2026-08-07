import { type Column } from "@tanstack/react-table"
import { ArrowDown, ArrowUp } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Sortable column header — click toggles asc↔desc (sorting never clears;
 * DataTable sets enableSortingRemoval: false). Switching to another column
 * sorts that column instead. First direction is auto: strings ascend
 * (A→Z / ↓), numbers descend (high→low / ↑), overridable per column with
 * `sortDescFirst`.
 *
 * Ghost-button hover chrome that bleeds around the title (padding + matching
 * negative margin so the label does not shift). Sort icons always occupy
 * layout beside the title. Mapping: ArrowDown = ascending, ArrowUp =
 * descending. Active sort: icon stays visible. Inactive: previews the
 * first-click direction on hover.
 */
interface DataTableColumnHeaderProps<TData, TValue>
  extends React.ComponentProps<"div"> {
  column: Column<TData, TValue>
  title: string
}

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  const alignEnd = className?.includes("justify-end")
  const rootClass = cn("flex items-center gap-1", alignEnd && "w-full justify-end", className)

  if (!column.getCanSort()) {
    return <div className={rootClass}>{title}</div>
  }

  const sorted = column.getIsSorted()
  // Preview the next click when unsorted (↓ for strings, ↑ for numbers).
  const direction = sorted || column.getNextSortingOrder()
  const SortIcon = direction === "desc" ? ArrowUp : ArrowDown
  const sortIcon = (
    <SortIcon
      aria-hidden
      data-slot="sort-icon"
      className={cn(
        // Darker than the muted label in both themes so active sort reads clearly.
        "size-3.5 shrink-0 text-foreground",
        sorted ? "opacity-100" : "opacity-0 group-hover/sort:opacity-100",
      )}
    />
  )

  return (
    <div className={rootClass}>
      <button
        type="button"
        className={cn(
          // Negative margin cancels the padding so the label stays put; hover
          // bg fills the padding and bleeds around the title like a ghost chip.
          // Label stays muted; only the sort arrow uses foreground contrast.
          "group/sort -mx-1.5 -my-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-muted-foreground",
          "hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
        onClick={column.getToggleSortingHandler()}
        aria-sort={
          sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
        }
      >
        {alignEnd ? (
          <>
            {sortIcon}
            {title}
          </>
        ) : (
          <>
            {title}
            {sortIcon}
          </>
        )}
      </button>
    </div>
  )
}
