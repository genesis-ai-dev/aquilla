import { type Column } from "@tanstack/react-table"
import { ArrowDown, ArrowUp } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Sortable column header — click cycles unsorted → desc → asc → unsorted
 * via TanStack's getToggleSortingHandler (table must set sortDescFirst).
 *
 * Ghost-button hover chrome that bleeds around the title (padding + matching
 * negative margin so the label does not shift). ArrowDown/ArrowUp always
 * occupy layout beside the title. Unsorted: ArrowDown only while hovering.
 * Sorted: icon stays visible.
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
  const SortIcon = sorted === "asc" ? ArrowUp : ArrowDown
  const sortIcon = (
    <SortIcon
      aria-hidden
      data-slot="sort-icon"
      className={cn(
        "size-3.5 shrink-0",
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
          "group/sort -mx-1.5 -my-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground",
          "hover:bg-muted/50 hover:text-foreground",
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
