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
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header"
import { cn } from "@/lib/utils"
import { Search } from "lucide-react"

function columnAlignClass(meta: unknown) {
  return (meta as { align?: "right" } | undefined)?.align === "right" ? "text-end" : undefined
}

/**
 * Docs-aligned data table shell — see
 * https://ui.shadcn.com/docs/components/base/data-table
 *
 * Tip from the guide: extract to `components/ui/data-table.tsx` when reused.
 * Callers own column defs and data; this owns the Table chrome + flexRender loop.
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
  /** Optional detail row rendered under a data row (e.g. expandable tenants). */
  renderSubRow?: (row: TData) => React.ReactNode
  /** Shown below the toolbar when `data` is empty (lens filters, etc.). Search still renders. */
  emptyState?: React.ReactNode
  /** Tighter row/header padding for portfolio-style lists (ReUI DataGrid `dense`). */
  dense?: boolean
}

function DataTable<TData, TValue>({
  columns,
  data,
  getRowId,
  initialSorting = [],
  searchPlaceholder,
  globalFilterFn,
  toolbar,
  testId,
  rowClassName,
  onRowClick,
  renderSubRow,
  emptyState,
  dense = false,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting)
  const [globalFilter, setGlobalFilter] = React.useState("")

  const table = useReactTable({
    data,
    columns,
    getRowId,
    // Click cycle: unsorted → desc → asc → clear (matches DataTableColumnHeader).
    sortDescFirst: true,
    enableSortingRemoval: true,
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
    },
  })

  const toolbarNode = typeof toolbar === "function" ? toolbar(table) : toolbar

  return (
    <div className={cn("flex w-full flex-col", dense ? "gap-2.5" : "gap-3")}>
      {(searchPlaceholder || toolbarNode) && (
        <div className="flex flex-wrap items-center gap-3">
          {searchPlaceholder ? (
            <InputGroup className="h-9 max-w-sm">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                placeholder={searchPlaceholder}
                value={globalFilter}
                onChange={(event) => setGlobalFilter(event.target.value)}
                aria-label={searchPlaceholder}
              />
            </InputGroup>
          ) : null}
          {toolbarNode}
        </div>
      )}
      {data.length === 0 && emptyState ? (
        emptyState
      ) : (
        <div className="overflow-hidden rounded-md border" data-testid={testId}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      dense && "h-9 py-1.5",
                      header.column.id === "expand" ? "w-8" : undefined,
                      columnAlignClass(header.column.columnDef.meta),
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => {
                const sub = renderSubRow?.(row.original)
                return (
                  <React.Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsSelected() && "selected"}
                      className={
                        typeof rowClassName === "function"
                          ? rowClassName(row.original)
                          : rowClassName
                      }
                      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            dense && "py-1.5",
                            columnAlignClass(cell.column.columnDef.meta),
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {sub}
                  </React.Fragment>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
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

export { DataTable, DataTableColumnHeader }
export type { DataTableProps }
