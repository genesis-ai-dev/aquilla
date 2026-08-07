/**
 * DataTable — docs shell from ui.shadcn.com/docs/components/base/data-table.
 * Verifies search, sort via DataTableColumnHeader, and empty results.
 */
import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "./data-table"

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

    const nameHeader = screen.getByRole("button", { name: /Name/i })
    expect(nameHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("opacity-100")
    expect(nameHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("lucide-arrow-down")

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

  it("renders emptyState below the toolbar when data is empty", () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        searchPlaceholder="Search…"
        emptyState={<div data-testid="custom-empty">Nothing here</div>}
      />,
    )
    expect(screen.getByLabelText("Search…")).toBeInTheDocument()
    expect(screen.getByTestId("custom-empty")).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})
