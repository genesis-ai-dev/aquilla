/**
 * AdminTenantsSection — flat org list. Verifies search filters orgs and row
 * click navigates into the org workspace. Nested team expansion lives on Teams.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AdminTenantsSection } from "./AdminTenantsSection"
import type { AdminOrg, AdminTeam } from "@/lib/frontier/admin"

const orgs: AdminOrg[] = [
  { id: 1, name: "Alpha", createdAt: "2026-01-01", ownerUsername: "al", memberCount: 3, projectCount: 2, activeLanguageCount: 12 },
  { id: 2, name: "Beta", createdAt: "2026-02-01", ownerUsername: "be", memberCount: 1, projectCount: 0, activeLanguageCount: 0 },
]
const teams: AdminTeam[] = [
  { id: 10, name: "alpha/translators", createdAt: "2026-01-02", orgId: 1, orgName: "Alpha", projectLeadUsername: "al", ownerUsername: "owen", memberCount: 2, projectCount: 1 },
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

  // AQU-1071: the billing band is a language count, and reading it meant opening
  // one org's Billing tab at a time. The tenants table carries it per tenant.
  it("shows each tenant's active-language count, and zero as a real zero", () => {
    render(<AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={vi.fn()} />)
    expect(screen.getByRole("columnheader", { name: /languages/i })).toBeInTheDocument()
    const alpha = screen.getByText("Alpha").closest("tr")!
    expect(alpha).toHaveTextContent("12")
    // An org with no active lane reads 0, not the "—" reserved for a server that
    // does not send the field at all.
    const beta = screen.getByText("Beta").closest("tr")!
    expect(beta).toHaveTextContent("0")
    expect(beta).not.toHaveTextContent("—")
  })

  it("shows an em dash for a server that does not report language counts", () => {
    render(
      <AdminTenantsSection
        orgs={[{ id: 3, name: "Gamma", createdAt: "2026-03-01", ownerUsername: "ga", memberCount: 1, projectCount: 1 }]}
        teams={[]}
        onOpenOrg={vi.fn()}
      />,
    )
    expect(screen.getByText("Gamma").closest("tr")!).toHaveTextContent("—")
  })

  it("calls onOpenOrg when a row is clicked", () => {
    const onOpenOrg = vi.fn()
    render(<AdminTenantsSection orgs={orgs} teams={teams} onOpenOrg={onOpenOrg} />)
    fireEvent.click(screen.getByText("Alpha").closest("tr")!)
    expect(onOpenOrg).toHaveBeenCalledWith(1)
  })
})
