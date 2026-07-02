/**
 * AdminPeopleSection — users with a platform-admin badge and an orphan-admin
 * callout. Verifies the badge is applied by email match and the callout lists
 * allowlisted emails with no account.
 */
import { describe, it, expect } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { AdminPeopleSection } from "./AdminPeopleSection"
import type { AdminUser, AdminAdmin } from "@/lib/frontier/admin"

const users: AdminUser[] = [
  { id: 1, username: "ryder", email: "Ryder@example.com", displayName: "Ryder", createdAt: "2026-01-01", orgCount: 2, lastActiveAt: "2026-06-30" },
  { id: 2, username: "casey", email: "casey@example.com", displayName: null, createdAt: "2026-03-01", orgCount: 1, lastActiveAt: null },
]
const admins: AdminAdmin[] = [
  { email: "ryder@example.com", hasAccount: true, userId: 1, username: "ryder" },
  { email: "ghost@example.com", hasAccount: false },
]

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
})
