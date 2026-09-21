/**
 * FillHeight / LegendList tables keep the header in a child that React
 * Compiler can freeze against TanStack's stable `table` object. This file
 * is in the compiler-on suite (vitest.compiler.config.ts) so that
 * regression cannot hide behind the default suite (compiler off).
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

describe("DataTable fillHeight sort headers", () => {
  it("updates header arrows when the active sort column changes", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        fillHeight
        initialSorting={[{ id: "name", desc: false }]}
      />,
    )
    const nameHeader = screen.getByRole("button", { name: /Name/i })
    const countHeader = screen.getByRole("button", { name: /Count/i })
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending")
    expect(nameHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("opacity-100")
    expect(countHeader).toHaveAttribute("aria-sort", "none")
    expect(countHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("opacity-0")

    fireEvent.click(countHeader)
    expect(countHeader).toHaveAttribute("aria-sort", "descending")
    expect(countHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("opacity-100")
    expect(countHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("lucide-arrow-up")
    expect(nameHeader).toHaveAttribute("aria-sort", "none")
    expect(nameHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("opacity-0")

    fireEvent.click(countHeader)
    expect(countHeader).toHaveAttribute("aria-sort", "ascending")
    expect(countHeader.querySelector('[data-slot="sort-icon"]')).toHaveClass("lucide-arrow-down")
    expect(bodyNames()).toEqual(["Gamma", "Beta", "Alpha"])
  })

  it("does not pin the previous first row when the list is re-sorted", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        fillHeight
        initialSorting={[{ id: "name", desc: false }]}
      />,
    )
    expect(screen.getByTestId("legend-list-mock")).toHaveAttribute(
      "data-maintain-visible-content-position",
      "false",
    )
  })
})
