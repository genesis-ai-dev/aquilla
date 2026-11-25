/**
 * AdminOrgView — one org for a platform admin: scoped projects, fetched
 * people with role labels, and the explicit "Open in app" action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AdminOrgView } from "./AdminOrgView"
import type { AdminOrg, AdminProject } from "@/lib/frontier/admin"

const getAdminOrgMembers = vi.fn()
const getAdminProjectsPage = vi.fn()
vi.mock("@/lib/frontier/admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/frontier/admin")>("@/lib/frontier/admin")
  return {
    ...actual,
    getAdminOrgMembers: (...a: unknown[]) => getAdminOrgMembers(...a),
    getAdminProjectsPage: (...a: unknown[]) => getAdminProjectsPage(...a),
  }
})

const org: AdminOrg = { id: 1, name: "Alpha", createdAt: "2026-01-01", ownerUsername: "al", memberCount: 2, projectCount: 1 }

function proj(over: Partial<AdminProject>): AdminProject {
  return {
    id: "p",
    name: "Project",
    orgId: 1,
    orgName: "Alpha",
    archived: false,
    createdAt: "2026-01-01",
    deadlineAt: null,
    creatorUsername: "al",
    totalCells: 10,
    validatedCells: 10,
    wordCount: 100,
    lastEditAt: Date.now(),
    shared: false,
    ...over,
  }
}

describe("AdminOrgView", () => {
  beforeEach(() => {
    getAdminOrgMembers.mockResolvedValue([
      { userId: 5, username: "al", displayName: null, email: "al@x", roleLevel: 700, joinedAt: "2026-01-01", lastActiveAt: null },
    ])
    getAdminProjectsPage.mockResolvedValue({
      rows: [proj({ id: "a", name: "Mine" })],
      total: 1,
      limit: 50,
      offset: 0,
      overdue: null,
    })
  })

  it("loads this org's project page and its people, and opens a person", async () => {
    const onSelectUser = vi.fn()
    const onOpenInApp = vi.fn()
    render(
      <MemoryRouter>
        <AdminOrgView
          jwt="jwt"
          org={org}
          tenantsHref="/admin?tab=tenants"
          onOpenInApp={onOpenInApp}
          onSelectUser={onSelectUser}
        />
      </MemoryRouter>,
    )
    expect(await screen.findByText("Mine")).toBeInTheDocument()
    expect(screen.queryByText("Theirs")).not.toBeInTheDocument()
    expect(getAdminProjectsPage).toHaveBeenCalledWith(
      "jwt",
      expect.objectContaining({ orgId: 1, limit: 50, offset: 0 }),
    )
    expect(screen.getByRole("link", { name: "All tenants" })).toHaveAttribute("href", "/admin?tab=tenants")

    const people = await screen.findByTestId("admin-org-people-table")
    expect(within(people).getByText("Owner")).toBeInTheDocument()
    expect(getAdminOrgMembers).toHaveBeenCalledWith("jwt", 1)
    fireEvent.click(within(people).getByText("al@x").closest("tr")!)
    expect(onSelectUser).toHaveBeenCalledWith(5)

    fireEvent.click(screen.getByRole("button", { name: /Open in app/ }))
    expect(onOpenInApp).toHaveBeenCalledWith(1)
    await waitFor(() => expect(getAdminOrgMembers).toHaveBeenCalledTimes(1))
  })
})
