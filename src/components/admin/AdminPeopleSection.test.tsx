/**
 * AdminPeopleSection — users with a platform-admin badge and an orphan-admin
 * callout. Verifies the badge is applied by email match and the callout lists
 * allowlisted emails with no account. Also covers TanStack search / sort.
 */
import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { AdminPeopleSection } from "./AdminPeopleSection"
import type { AdminUser, AdminAdmin } from "@/lib/frontier/admin"

const users: AdminUser[] = [
  { id: 1, username: "ryder", email: "Ryder@example.com", displayName: "Ryder", createdAt: "2026-01-01", orgCount: 2, lastActiveAt: "2026-06-30" },
  { id: 2, username: "casey", email: "casey@example.com", displayName: null, createdAt: "2026-03-01", orgCount: 1, lastActiveAt: null },
  { id: 3, username: "alpha", email: "alpha@example.com", displayName: "Alpha", createdAt: "2026-02-01", orgCount: 10, lastActiveAt: "2026-07-01" },
]
const admins: AdminAdmin[] = [
  { email: "ryder@example.com", hasAccount: true, userId: 1, username: "ryder" },
  { email: "ghost@example.com", hasAccount: false },
]

const bodyFirstCells = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((tr) => {
      const cell = within(tr).getAllByRole("cell")[0]
      const name =
        cell?.querySelector('[data-slot="username"]')?.textContent
        ?? cell?.textContent
        ?? ""
      return name.replace(/\s*Platform admin$/i, "")
    })

describe("AdminPeopleSection", () => {
  it("badges the allowlisted user (case-insensitive email match)", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    const ryderRow = screen.getByText(/Ryder \(ryder\)/).closest("tr")!
    expect(within(ryderRow).getByText(/platform admin/i)).toBeInTheDocument()
    const caseyRow = screen.getByText("casey").closest("tr")!
    expect(within(caseyRow).queryByText(/platform admin/i)).not.toBeInTheDocument()
  })

  it("warns about allowlisted emails with no account", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    expect(screen.getByText(/no account/i)).toBeInTheDocument()
    expect(screen.getByText(/ghost@example.com/)).toBeInTheDocument()
  })

  it("renders Empty when there are no users", () => {
    render(<AdminPeopleSection users={[]} admins={[]} />)
    expect(screen.getByText("No users yet")).toBeInTheDocument()
  })

  it("filters rows by the search query", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    fireEvent.change(screen.getByLabelText("Search people…"), { target: { value: "casey" } })
    expect(bodyFirstCells()).toHaveLength(1)
    expect(bodyFirstCells()[0]).toContain("casey")
  })

  it("shows No results when the query matches nothing", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    fireEvent.change(screen.getByLabelText("Search people…"), { target: { value: "zzz" } })
    expect(screen.getByText("No results.")).toBeInTheDocument()
  })

  it("shows short calendar dates for last active and joined", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    const joined = new Date("2026-01-01").toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
    })
    expect(screen.getAllByText(joined).length).toBeGreaterThanOrEqual(1)
  })

  it("cycles Orgs sort on header click: desc → asc → clear", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    const orgsHeader = screen.getByRole("button", { name: /Orgs/i })
    // Default initial sort is lastActive desc — capture names after switching to Orgs.
    fireEvent.click(orgsHeader) // desc by orgCount
    expect(bodyFirstCells()).toEqual([
      "Alpha (alpha)",
      "Ryder (ryder)",
      "casey",
    ])
    fireEvent.click(orgsHeader) // asc
    expect(bodyFirstCells()).toEqual([
      "casey",
      "Ryder (ryder)",
      "Alpha (alpha)",
    ])
    fireEvent.click(orgsHeader) // clear — falls back to insertion order
    expect(bodyFirstCells()).toEqual([
      "Ryder (ryder)",
      "casey",
      "Alpha (alpha)",
    ])
  })
})
