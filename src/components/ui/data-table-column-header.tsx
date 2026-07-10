import { type Column } from "@tanstack/react-table"
import { ArrowDown, ArrowUp } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Sortable column header — click cycles unsorted → desc → asc → unsorted
 * via TanStack's getToggleSortingHandler (table must set sortDescFirst).
 *
 * Renders as a plain header control (not a Button) so it stays visually
 * aligned with table chrome; Lucide ArrowUp / ArrowDown only while sorted.
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
  const SortIcon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : null

  return (
    <div className={rootClass}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1.5 font-medium text-foreground",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          "rounded-sm",
        )}
        onClick={column.getToggleSortingHandler()}
        aria-sort={
          sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
        }
      >
        {title}
        {SortIcon ? <SortIcon aria-hidden className="size-3.5 shrink-0" /> : null}
      </button>
    </div>
  )
}
