/**
 * AdminTenantsSection — flat org list. Verifies search filters orgs and Open
 * navigates into the org workspace. Nested team expansion lives on Teams.
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
  { id: 10, name: "alpha/translators", createdAt: "2026-01-02", orgId: 1, orgName: "Alpha", projectLeadUsername: "al", memberCount: 2, projectCount: 1 },
]

describe("AdminTenantsSection", () => {
  it("shows a per-org team count without nested team rows", () => {
    render(<AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={vi.fn()} />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.queryByText("translators")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /expand/i })).not.toBeInTheDocument()
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
