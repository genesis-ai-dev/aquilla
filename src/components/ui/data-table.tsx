import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type FilterFn,
  type SortingState,
  type Table as TanStackTable,
} from "@tanstack/react-table"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ContextMenu,
  ContextMenuTrigger,
  openContextMenuAtPointer,
} from "@/components/ui/context-menu"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header"
import { cn } from "@/lib/utils"
import { MoreHorizontal, Search } from "lucide-react"

function columnMetaClass(meta: unknown) {
  const m = meta as { align?: "right"; className?: string; hidden?: boolean } | undefined
  return cn(m?.align === "right" && "text-right", m?.className)
}

function columnId<TData, TValue>(col: ColumnDef<TData, TValue>): string | undefined {
  if (col.id != null) return col.id
  if (typeof col.accessorKey === "string" || typeof col.accessorKey === "number") {
    return String(col.accessorKey)
  }
  return undefined
}

/** First sortable *visible* column, ascending — tables are never unsorted. */
function defaultSorting<TData, TValue>(
  columns: ColumnDef<TData, TValue>[],
): SortingState {
  for (const col of columns) {
    if (col.enableSorting === false) continue
    const meta = col.meta as { hidden?: boolean } | undefined
    if (meta?.hidden) continue
    const id = columnId(col)
    if (!id) continue
    return [{ id, desc: false }]
  }
  return []
}

function hiddenColumnVisibility<TData, TValue>(
  columns: ColumnDef<TData, TValue>[],
): Record<string, boolean> {
  const visibility: Record<string, boolean> = {}
  for (const col of columns) {
    const meta = col.meta as { hidden?: boolean } | undefined
    if (!meta?.hidden) continue
    const id = columnId(col)
    if (id) visibility[id] = false
  }
  return visibility
}

/**
 * Docs-aligned data table shell — see
 * https://ui.shadcn.com/docs/components/base/data-table
 *
 * Tip from the guide: extract to `components/ui/data-table.tsx` when reused.
 * Callers own column defs and data; this owns the Table chrome + flexRender loop.
 *
 * Sorting is always on: headers toggle asc↔desc only (never clear). When
 * `initialSorting` is omitted, the first sortable column starts ascending.
 */
interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  getRowId?: (originalRow: TData, index: number) => string
  initialSorting?: SortingState
  /** When set, renders a search input that drives TanStack `globalFilter`. */
  searchPlaceholder?: string
  globalFilterFn?: FilterFn<TData>
  /** Extra controls in the toolbar row (counts, lens filters, etc.). */
  toolbar?: React.ReactNode | ((table: TanStackTable<TData>) => React.ReactNode)
  testId?: string
  /** Optional class on each body row (e.g. `align-top` for dense admin cells). */
  rowClassName?: string | ((row: TData) => string | undefined)
  /** When set, clicking a body row invokes this handler (e.g. navigate on row). */
  onRowClick?: (row: TData) => void
  /**
   * Right-click / ⋯ menu for a body row. Return `ContextMenuContent` (and
   * nested items); the row becomes the ContextMenu trigger. Return null to
   * skip the menu for that row.
   */
  renderRowContextMenu?: (row: TData) => React.ReactNode
  /** Optional detail row rendered under a data row (e.g. expandable tenants). */
  renderSubRow?: (row: TData) => React.ReactNode
  /** Shown when there are no rows to display (empty data or search/filter miss). */
  emptyState?: React.ReactNode | ((table: TanStackTable<TData>) => React.ReactNode)
  /**
   * Compact row/header padding for portfolio-style lists (ReUI DataGrid `dense`).
   * Off = comfortable row height (`py-2.5` / `h-11`); on = tight (`py-1.5` / `h-9`).
   */
  dense?: boolean
  /** Class on the bordered table wrapper (e.g. `border-0` when nested in a card). */
  className?: string
}

function DataTable<TData, TValue>({
  columns,
  data,
  getRowId,
  initialSorting,
  searchPlaceholder,
  globalFilterFn,
  toolbar,
  testId,
  rowClassName,
  onRowClick,
  renderRowContextMenu,
  renderSubRow,
  emptyState,
  dense = false,
  className,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>(
    () => (initialSorting?.length ? initialSorting : defaultSorting(columns)),
  )
  const [globalFilter, setGlobalFilter] = React.useState("")
  const [columnVisibility] = React.useState(() => hiddenColumnVisibility(columns))

  const table = useReactTable({
    data,
    columns,
    getRowId,
    // Always sorted: header clicks flip asc↔desc only (never clear).
    // First-click dir on a new column is auto (strings asc / numbers desc)
    // unless the column sets sortDescFirst.
    enableSortingRemoval: false,
    enableMultiSort: false,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn,
    state: {
      sorting,
      globalFilter,
      columnVisibility,
    },
  })

  const toolbarNode = typeof toolbar === "function" ? toolbar(table) : toolbar
  const emptyStateNode = typeof emptyState === "function" ? emptyState(table) : emptyState
  const hasRows = table.getRowModel().rows.length > 0

  return (
    <div className={cn("flex w-full flex-col", dense ? "gap-2.5" : "gap-3")}>
      {(searchPlaceholder || toolbarNode) && (
        <div className="flex flex-wrap items-center gap-3">
          {searchPlaceholder ? (
            <InputGroup className="max-w-xs bg-card">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                placeholder={searchPlaceholder}
                value={globalFilter}
                onChange={(event) => setGlobalFilter(event.target.value)}
                aria-label={searchPlaceholder}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </InputGroup>
          ) : null}
          {toolbarNode}
        </div>
      )}
      {!hasRows && emptyStateNode ? (
        emptyStateNode
      ) : (
        <div
          className={cn("overflow-hidden rounded-md border", className)}
          data-testid={testId}
        >
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  if (!header.column.getIsVisible()) return null
                  return (
                  <TableHead
                    key={header.id}
                    className={cn(
                      dense ? "h-9 py-1.5" : "h-11",
                      header.column.id === "expand" ? "w-8" : undefined,
                      columnMetaClass(header.column.columnDef.meta),
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {hasRows ? (
              table.getRowModel().rows.map((row) => {
                const sub = renderSubRow?.(row.original)
                const contextMenu = renderRowContextMenu?.(row.original) ?? null
                const cells = row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      dense ? "py-1.5" : "py-2.5",
                      columnMetaClass(cell.column.columnDef.meta),
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))
                const rowProps = {
                  "data-state": row.getIsSelected() && "selected",
                  className: cn(
                    typeof rowClassName === "function"
                      ? rowClassName(row.original)
                      : rowClassName,
                  ),
                  onClick: onRowClick ? () => onRowClick(row.original) : undefined,
                } as const
                return (
                  <React.Fragment key={row.id}>
                    {contextMenu ? (
                      <ContextMenu>
                        <ContextMenuTrigger
                          render={<TableRow {...rowProps} />}
                        >
                          {cells}
                        </ContextMenuTrigger>
                        {contextMenu}
                      </ContextMenu>
                    ) : (
                      <TableRow {...rowProps}>{cells}</TableRow>
                    )}
                    {sub}
                  </React.Fragment>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      )}
    </div>
  )
}

/**
 * Ghost ⋯ control that opens the row ContextMenu at the pointer.
 * Pair with `renderRowContextMenu` on DataTable (same pattern as FileRow).
 */
function DataTableRowActionsButton({
  label,
  disabled,
  busy,
  className,
  ...props
}: {
  label: string
  disabled?: boolean
  busy?: boolean
  className?: string
} & Omit<React.ComponentProps<typeof Button>, "children" | "size" | "variant" | "type" | "aria-label" | "onClick">) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      disabled={disabled}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={(e) => {
        e.stopPropagation()
        openContextMenuAtPointer(e.currentTarget, e.clientX, e.clientY)
      }}
      {...props}
    >
      {busy ? <Spinner /> : <MoreHorizontal className="size-4" />}
    </Button>
  )
}

export { DataTable, DataTableColumnHeader, DataTableRowActionsButton }
export type { DataTableProps }
