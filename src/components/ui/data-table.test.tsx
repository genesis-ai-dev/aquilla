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

  it("cycles sort on header click: desc → asc → clear", () => {
    render(
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r.id)} />,
    )
    const countHeader = screen.getByRole("button", { name: /Count/i })
    const unsorted = bodyNames()
    fireEvent.click(countHeader) // desc
    expect(bodyNames()).toEqual(["Alpha", "Beta", "Gamma"])
    fireEvent.click(countHeader) // asc
    expect(bodyNames()).toEqual(["Gamma", "Beta", "Alpha"])
    fireEvent.click(countHeader) // clear
    expect(bodyNames()).toEqual(unsorted)
  })
})
