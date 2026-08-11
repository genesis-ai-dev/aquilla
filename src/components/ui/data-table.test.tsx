/**
 * DataTable — docs shell from ui.shadcn.com/docs/components/base/data-table.
 * Verifies search, sort via DataTableColumnHeader, and empty results.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader, DataTableRowActionsButton } from "./data-table"
import { MenuItem } from "./menu-parts"

interface Row {
  id: number
  name: string
  count: number
}

const rows: Row[] = [
  { id: 1, name: "Beta", count: 3 },
  { id: 2, name: "Alpha", count: 10 },
  { id: 3, name: "Gamma", count: 1 },
]

const columns: ColumnDef<Row>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
    cell: ({ row }) => row.original.name,
  },
  {
    accessorKey: "count",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Count" />,
    cell: ({ row }) => row.original.count,
  },
]

/** A table whose rows carry a menu on both routes: right-click and the ⋯ button. */
const renderRowMenuTable = (
  handlers: { onRowClick?: (row: Row) => void; onAct?: () => void } = {},
) =>
  render(
    <DataTable
      columns={[
        ...columns,
        {
          id: "actions",
          enableSorting: false,
          cell: ({ row }) => (
            <DataTableRowActionsButton label={`More actions for ${row.original.name}`} />
          ),
        },
      ]}
      data={rows}
      getRowId={(r) => String(r.id)}
      onRowClick={handlers.onRowClick}
      renderRowMenuItems={(r) => (
        <MenuItem onClick={handlers.onAct}>Act on {r.name}</MenuItem>
      )}
    />,
  )

const bodyNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent)

describe("DataTable", () => {
  it("renders No results when filtered empty", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        searchPlaceholder="Search…"
        globalFilterFn={(row, _id, value) =>
          row.original.name.toLowerCase().includes(String(value).toLowerCase())
        }
      />,
    )
    fireEvent.change(screen.getByLabelText("Search…"), { target: { value: "zzz" } })
    expect(screen.getByText("No results.")).toBeInTheDocument()
  })

  it("filters rows by global search", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        searchPlaceholder="Search…"
        globalFilterFn={(row, _id, value) =>
          row.original.name.toLowerCase().includes(String(value).toLowerCase())
        }
      />,
    )
    fireEvent.change(screen.getByLabelText("Search…"), { target: { value: "al" } })
    expect(bodyNames()).toEqual(["Alpha"])
  })

  it("cycles numeric sort on header click: desc ↔ asc (never clears)", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        initialSorting={[{ id: "name", desc: false }]}
      />,
    )
    const countHeader = screen.getByRole("button", { name: /Count/i })
    fireEvent.click(countHeader) // desc (numbers auto sortDescFirst)
    expect(bodyNames()).toEqual(["Alpha", "Beta", "Gamma"])
    fireEvent.click(countHeader) // asc
    expect(bodyNames()).toEqual(["Gamma", "Beta", "Alpha"])
    fireEvent.click(countHeader) // desc again — sorting never clears
    expect(bodyNames()).toEqual(["Alpha", "Beta", "Gamma"])
  })

  it("cycles string sort on header click: asc ↔ desc (never clears)", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        initialSorting={[{ id: "count", desc: true }]}
      />,
    )
    const nameHeader = screen.getByRole("button", { name: /Name/i })
    fireEvent.click(nameHeader) // asc (strings auto)
    expect(bodyNames()).toEqual(["Alpha", "Beta", "Gamma"])
    fireEvent.click(nameHeader) // desc
    expect(bodyNames()).toEqual(["Gamma", "Beta", "Alpha"])
    fireEvent.click(nameHeader) // asc again — sorting never clears
    expect(bodyNames()).toEqual(["Alpha", "Beta", "Gamma"])
  })

  it("defaults to the first sortable column ascending when initialSorting is omitted", () => {
    render(
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r.id)} />,
    )
    expect(bodyNames()).toEqual(["Alpha", "Beta", "Gamma"])
    expect(screen.getByRole("button", { name: /Name/i })).toHaveAttribute(
      "aria-sort",
      "ascending",
    )
  })

  it("keeps an invisible sort arrow until an inactive header is hovered", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        initialSorting={[{ id: "name", desc: false }]}
      />,
    )
    const countHeader = screen.getByRole("button", { name: /Count/i })
    const icon = countHeader.querySelector('[data-slot="sort-icon"]')
    expect(icon).toBeTruthy()
    expect(icon).toHaveClass("opacity-0")
    expect(icon).toHaveClass("group-hover/sort:opacity-100")
    expect(icon).toHaveClass("lucide-arrow-up") // numbers preview desc
    expect(countHeader).toHaveClass("hover:bg-muted/50")
    expect(countHeader).toHaveClass("text-muted-foreground")
    expect(icon).toHaveClass("text-foreground")

    const nameHeader = screen.getByRole("button", { name: /Name/i })
    expect(nameHeader).toHaveClass("text-muted-foreground")
    expect(nameHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("opacity-100")
    expect(nameHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("lucide-arrow-down")
    expect(nameHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("text-foreground")

    fireEvent.click(countHeader) // desc — ArrowUp (high→low), stays visible
    const descIcon = countHeader.querySelector('[data-slot="sort-icon"]')
    expect(descIcon).toHaveClass("opacity-100")
    expect(descIcon).toHaveClass("lucide-arrow-up")
    fireEvent.click(countHeader) // asc — ArrowDown (low→high)
    const ascIcon = countHeader.querySelector('[data-slot="sort-icon"]')
    expect(ascIcon).toHaveClass("opacity-100")
    expect(ascIcon).toHaveClass("lucide-arrow-down")
  })

  it("applies dense row padding when dense is set", () => {
    const { container } = render(
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r.id)} dense />,
    )
    const cell = container.querySelector('[data-slot="table-cell"]')
    expect(cell?.className).toMatch(/py-1\.5/)
    const head = container.querySelector('[data-slot="table-head"]')
    expect(head?.className).toMatch(/h-9/)
  })

  it("uses comfortable row height when dense is off", () => {
    const { container } = render(
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r.id)} />,
    )
    const cell = container.querySelector('[data-slot="table-cell"]')
    expect(cell?.className).toMatch(/py-2\.5/)
    expect(cell?.className).not.toMatch(/py-1\.5/)
    const head = container.querySelector('[data-slot="table-head"]')
    expect(head?.className).toMatch(/h-11/)
  })

  it("renders emptyState inside the table panel when data is empty", () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        searchPlaceholder="Search…"
        emptyState={<div data-testid="custom-empty">Nothing here</div>}
        testId="empty-table"
        className="bg-card"
      />,
    )
    expect(screen.getByLabelText("Search…")).toBeInTheDocument()
    expect(screen.getByTestId("custom-empty")).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.getByTestId("empty-table")).toHaveClass("border", "bg-card")
  })

  it("opens renderRowMenuItems from row right-click and from the ⋯ button", async () => {
    renderRowMenuTable()

    const alphaRow = screen.getByText("Alpha").closest("tr")!
    const alphaBtn = screen.getByRole("button", { name: "More actions for Alpha" })
    fireEvent.contextMenu(alphaRow)
    expect(screen.getByRole("menuitem", { name: "Act on Alpha" })).toBeInTheDocument()
    // Open chrome belongs to the button's own menu, not to a row right-click.
    expect(alphaBtn).toHaveAttribute("aria-expanded", "false")
    fireEvent.keyDown(document, { key: "Escape" })

    const betaBtn = screen.getByRole("button", { name: "More actions for Beta" })
    fireEvent.click(betaBtn)
    expect(screen.getByRole("menuitem", { name: "Act on Beta" })).toBeInTheDocument()
    expect(betaBtn).toHaveAttribute("aria-expanded", "true")
  })

  it("gives the ⋯ button the menu trigger contract instead of a synthetic right-click", async () => {
    renderRowMenuTable()
    const btn = screen.getByRole("button", { name: "More actions for Alpha" })

    expect(btn).toHaveAttribute("aria-haspopup", "menu")

    // A keyboard activation reports no pointer coordinates. The button used to
    // dispatch a synthetic `contextmenu` at those coordinates, which anchored the
    // menu to the top-left corner of the viewport; as a real trigger the popup is
    // the button's own, so it anchors to the button however it was activated.
    fireEvent.click(btn, { detail: 0, clientX: 0, clientY: 0 })

    const popup = document.querySelector('[data-slot="dropdown-menu-content"]')
    expect(popup).not.toBeNull()
    expect(btn.getAttribute("aria-controls")).toBe(popup!.id)
    expect(screen.getByRole("menuitem", { name: "Act on Alpha" })).toBeInTheDocument()
  })

  it("keeps a menu press out of a clickable row's own handler", () => {
    const onRowClick = vi.fn()
    const onAct = vi.fn()
    renderRowMenuTable({ onRowClick, onAct })

    fireEvent.click(screen.getByRole("button", { name: "More actions for Alpha" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Act on Alpha" }))

    expect(onAct).toHaveBeenCalledTimes(1)
    // The popup is portalled out of the table, but React bubbles its events
    // along the React tree — which runs through the row.
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
