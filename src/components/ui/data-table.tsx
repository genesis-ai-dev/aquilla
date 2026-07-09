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

import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header"

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
  /** Optional detail row rendered under a data row (e.g. expandable tenants). */
  renderSubRow?: (row: TData) => React.ReactNode
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
  renderSubRow,
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
    <div className="flex w-full flex-col gap-3">
      {(searchPlaceholder || toolbarNode) && (
        <div className="flex flex-wrap items-center gap-3">
          {searchPlaceholder ? (
            <Input
              placeholder={searchPlaceholder}
              value={globalFilter}
              onChange={(event) => setGlobalFilter(event.target.value)}
              aria-label={searchPlaceholder}
              className="max-w-sm"
            />
          ) : null}
          {toolbarNode}
        </div>
      )}
      <div className="overflow-hidden rounded-md border" data-testid={testId}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={header.column.id === "expand" ? "w-8" : undefined}
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
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
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
    </div>
  )
}

export { DataTable, DataTableColumnHeader }
export type { DataTableProps }
