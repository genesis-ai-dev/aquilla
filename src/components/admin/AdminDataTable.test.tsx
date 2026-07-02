/**
 * AdminDataTable — the shared admin list primitive. Verifies search filtering,
 * click-to-sort (asc/desc toggle), the empty and no-match states, and row click.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { AdminDataTable, type AdminColumn } from "./AdminDataTable"

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

const columns: AdminColumn<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name, sortValue: (r) => r.name },
  { key: "count", header: "Count", align: "right", render: (r) => r.count, sortValue: (r) => r.count },
]

function renderTable(props: Partial<React.ComponentProps<typeof AdminDataTable<Row>>> = {}) {
  return render(
    <AdminDataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      searchText={(r) => r.name}
      empty={{ title: "Nothing here" }}
      {...props}
    />,
  )
}

const bodyNames = () =>
  screen
    .getAllByRole("row")
    .slice(1) // drop the header row
    .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent)

describe("AdminDataTable", () => {
  it("renders the caller's EmptyState when there are no rows", () => {
    render(
      <AdminDataTable columns={columns} rows={[]} getRowKey={(r) => r.id} empty={{ title: "Nothing here" }} />,
    )
    expect(screen.getByText("Nothing here")).toBeInTheDocument()
  })

  it("filters rows by the search projection", () => {
    renderTable()
    fireEvent.change(screen.getByLabelText("Search…"), { target: { value: "al" } })
    expect(bodyNames()).toEqual(["Alpha"])
  })

  it("shows a no-match note when the query matches nothing", () => {
    renderTable()
    fireEvent.change(screen.getByLabelText("Search…"), { target: { value: "zzz" } })
    expect(screen.getByText(/No matches/i)).toBeInTheDocument()
  })

  it("sorts ascending then descending on header click", () => {
    renderTable()
    const countHeader = screen.getByRole("button", { name: /Count/i })
    fireEvent.click(countHeader) // asc by count
    expect(bodyNames()).toEqual(["Gamma", "Beta", "Alpha"])
    fireEvent.click(countHeader) // desc by count
    expect(bodyNames()).toEqual(["Alpha", "Beta", "Gamma"])
  })

  it("invokes onRowClick when a row is activated", () => {
    const onRowClick = vi.fn()
    renderTable({ onRowClick })
    fireEvent.click(screen.getByText("Gamma"))
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }))
  })
})
