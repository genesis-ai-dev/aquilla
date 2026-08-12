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
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  if ("accessorKey" in col && (typeof col.accessorKey === "string" || typeof col.accessorKey === "number")) {
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
  /** Extra attributes on each body row (e.g. `data-project-id` for tests). */
  getRowAttributes?: (
    row: TData,
  ) => Record<string, string | number | undefined | null> | undefined
  /**
   * Items for a body row's menu, reachable two ways: right-click anywhere on the
   * row, or the ⋯ button (`DataTableRowActionsButton`) in an actions column.
   * Return the items themselves (`MenuItem`, `MenuSeparator`, `MenuSub`, …) —
   * this owns the popup around them, because each way of opening needs its own
   * root. Return null to skip the menu for that row.
   */
  renderRowMenuItems?: (row: TData) => React.ReactNode
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
  /**
   * Fill a flex parent and scroll only the table body — keeps search/toolbar
   * pinned above while rows scroll (in-card portfolio panels).
   */
  fillHeight?: boolean
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
  getRowAttributes,
  renderRowMenuItems,
  renderSubRow,
  emptyState,
  dense = false,
  className,
  fillHeight = false,
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
    <div
      className={cn(
        "flex w-full flex-col",
        fillHeight && "min-h-0 flex-1",
        dense ? "gap-2.5" : "gap-3",
      )}
    >
      {(searchPlaceholder || toolbarNode) && (
        <div className="flex shrink-0 flex-wrap items-center gap-3">
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
      <div
        className={cn(
          "rounded-md border",
          className,
          // After `className` so fillHeight scroll wins over admin
          // `overflow-visible` chrome.
          fillHeight
            ? "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card"
            : "overflow-hidden",
        )}
        data-testid={testId}
      >
        {!hasRows && emptyStateNode ? (
          emptyStateNode
        ) : (
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
                        fillHeight && "bg-card",
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
                  const menuItems = renderRowMenuItems?.(row.original) ?? null
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
                    ...getRowAttributes?.(row.original),
                    className: cn(
                      menuItems && "group",
                      typeof rowClassName === "function"
                        ? rowClassName(row.original)
                        : rowClassName,
                    ),
                    onClick: onRowClick ? () => onRowClick(row.original) : undefined,
                  } as const
                  return (
                    <React.Fragment key={row.id}>
                      {menuItems ? (
                        <DataTableRowMenu rowProps={rowProps} items={menuItems}>
                          {cells}
                        </DataTableRowMenu>
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
        )}
      </div>
    </div>
  )
}

/** Both of a row's popups get the same width, so the two routes look alike. */
const ROW_MENU_CLASS = "w-auto min-w-40"

/**
 * Lets the ⋯ button in an actions cell open the same items as its row, without
 * every caller having to hand them to the button as well.
 */
const RowMenuItemsContext = React.createContext<React.ReactNode>(null)

/**
 * A row's menu, reachable by right-clicking the row or by pressing its ⋯ button.
 *
 * This needs two roots rather than one: Base UI anchors a context menu's popup to
 * the pointer, so the same root cannot also anchor to a button. The row owns the
 * context-menu root; the button owns the menu root, inside its own cell — a
 * non-modal popup renders focus guards next to itself, and a `<tr>` may only
 * contain cells.
 */
function DataTableRowMenu({
  rowProps,
  children,
  items,
}: {
  rowProps: React.ComponentProps<typeof TableRow>
  children: React.ReactNode
  items: React.ReactNode
}) {
  return (
    <RowMenuItemsContext.Provider value={items}>
      <ContextMenu>
        <ContextMenuTrigger render={<TableRow {...rowProps} />}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className={ROW_MENU_CLASS}>{items}</ContextMenuContent>
      </ContextMenu>
    </RowMenuItemsContext.Provider>
  )
}

/**
 * Ghost ⋯ control for an actions column, and a real trigger for the row's menu:
 * it carries `aria-haspopup`/`aria-expanded`, and the menu opens under the button
 * for keyboard users as well as pointer users. Pair with `renderRowMenuItems`.
 *
 * Open chrome comes from the shared Button's `aria-expanded` ghost styling, so it
 * appears only when this button opened the menu — not on a row right-click.
 */
function DataTableRowActionsButton({
  label,
  disabled,
  busy,
  revealOnHover = false,
  className,
  ...props
}: {
  label: string
  disabled?: boolean
  busy?: boolean
  /** Hide until the row is hovered / focused / menu opened (appears instantly). */
  revealOnHover?: boolean
  className?: string
} & Omit<
  React.ComponentProps<typeof DropdownMenuTrigger>,
  "children" | "render" | "className" | "disabled" | "aria-label" | "onClick"
>) {
  const items = React.useContext(RowMenuItemsContext)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        {...props}
        data-row-actions=""
        aria-label={label}
        disabled={disabled}
        // Rows are often clickable; this press belongs to the menu, not the row.
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          // Snap hover/active paint (no muddy transparent→accent fade). Keep
          // transform so the shared Button active translate still works.
          "transition-transform",
          revealOnHover && [
            "opacity-100",
            "[@media(hover:hover)_and_(pointer:fine)]:opacity-0",
            "[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100",
            "[@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100",
            "[@media(hover:hover)_and_(pointer:fine)]:group-data-popup-open:opacity-100",
            "[@media(hover:hover)_and_(pointer:fine)]:aria-expanded:opacity-100",
          ],
          className,
        )}
        render={<Button type="button" size="icon-sm" variant="ghost" />}
      >
        {busy ? <Spinner /> : <MoreHorizontal className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={ROW_MENU_CLASS}
        // The popup is portalled out of the table, but React still bubbles its
        // events along the React tree — through the row. Rows are often
        // clickable, so pressing an item must not also count as a row click.
        onClick={(event) => event.stopPropagation()}
      >
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { DataTable, DataTableColumnHeader, DataTableRowActionsButton }
export type { DataTableProps }
