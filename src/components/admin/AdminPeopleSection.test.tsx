/**
 * AdminPeopleSection — users with a Role column for platform admins and an
 * orphan-admin callout. Verifies Role is applied by email match and the callout
 * lists allowlisted emails with no account. Also covers TanStack search / sort.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import { toast } from "@/components/ui/toast"
import { AdminPeopleSection } from "./AdminPeopleSection"
import type { AdminUser, AdminAdmin } from "@/lib/frontier/admin"

vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}))


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
      return (
        cell?.querySelector('[data-slot="username"]')?.textContent
        ?? cell?.textContent
        ?? ""
      )
    })

describe("AdminPeopleSection", () => {
  it("shows Platform admin in the Role column for allowlisted users", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    expect(screen.getByRole("columnheader", { name: /^Role$/i })).toBeInTheDocument()
    const ryderRow = screen.getByText(/Ryder \(ryder\)/).closest("tr")!
    expect(within(ryderRow).getByText("Platform admin")).toBeInTheDocument()
    const caseyRow = screen.getByText("casey").closest("tr")!
    expect(within(caseyRow).queryByText("Platform admin")).not.toBeInTheDocument()
    const caseyRoleCell = within(caseyRow).getAllByRole("cell")[2]
    expect(caseyRoleCell).toHaveTextContent("")
  })

  it("copies email when the muted email button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    render(<AdminPeopleSection users={users} admins={admins} />)
    const btn = screen.getByRole("button", { name: /copy casey@example.com/i })
    expect(btn).toHaveClass("text-muted-foreground")
    fireEvent.click(btn)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("casey@example.com"))
    expect(toast.add).toHaveBeenCalledWith({
      type: "success",
      title: "Email copied to clipboard",
    })
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

  it("cycles Orgs sort on header click: desc ↔ asc (never clears)", () => {
    render(<AdminPeopleSection users={users} admins={admins} />)
    const orgsHeader = screen.getByRole("button", { name: /Orgs/i })
    // Default initial sort is user A→Z — capture names after switching to Orgs.
    // orgCount is numeric → first click descends (highest first).
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
    fireEvent.click(orgsHeader) // desc again — sorting never clears
    expect(bodyFirstCells()).toEqual([
      "Alpha (alpha)",
      "Ryder (ryder)",
      "casey",
    ])
  })
})
