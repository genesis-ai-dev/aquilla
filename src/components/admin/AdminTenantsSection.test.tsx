/**
 * AdminTenantsSection — orgs with expandable team rows. Verifies expansion
 * reveals an org's teams, search filters orgs, and Open drills into the org.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AdminTenantsSection } from "./AdminTenantsSection"
import type { AdminOrg, AdminTeam } from "@/lib/frontier/admin"

const orgs: AdminOrg[] = [
  { id: 1, name: "Alpha", createdAt: "2026-01-01", ownerUsername: "al", memberCount: 3, projectCount: 2 },
  { id: 2, name: "Beta", createdAt: "2026-02-01", ownerUsername: "be", memberCount: 1, projectCount: 0 },
]
const teams: AdminTeam[] = [
  { id: 10, name: "alpha/translators", createdAt: "2026-01-02", orgId: 1, orgName: "Alpha", memberCount: 2, projectCount: 1 },
]

describe("AdminTenantsSection", () => {
  it("expands an org to reveal its teams", () => {
    render(<AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={vi.fn()} />)
    expect(screen.queryByText("translators")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /expand alpha/i }))
    expect(screen.getByText("translators")).toBeInTheDocument()
  })

  it("filters orgs by search", () => {
    render(<AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/search organizations/i), { target: { value: "beta" } })
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument()
  })

  it("shows a short created date with tooltip", () => {
    render(<AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={vi.fn()} />)
    const created = new Date("2026-01-01").toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
    })
    expect(screen.getByText(created)).toBeInTheDocument()
  })

  it("calls onOpenOrg when Open is clicked", () => {
    const onOpenOrg = vi.fn()
    render(<AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={onOpenOrg} />)
    fireEvent.click(screen.getAllByRole("button", { name: /open/i })[0])
    expect(onOpenOrg).toHaveBeenCalledWith(1)
  })
})
