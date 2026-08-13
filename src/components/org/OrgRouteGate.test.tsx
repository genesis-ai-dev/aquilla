import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { OrgRouteGate } from "./OrgRouteGate"

// AQU-790: guest orgs use the same `/orgs/:orgId` path convention as owned
// orgs. The gate must (a) admit a guest org's index route, (b) wait for the
// project directory before rejecting a possible guest org (so a reload doesn't
// flash not-found), and (c) keep guests out of member-only tool sub-routes.

const orgContext = vi.hoisted(() => ({
  orgs: [] as { id: number }[],
  guestOrgs: [] as { id: number; name: string | null }[],
  isLoading: false,
  accessibleProjectsLoading: false,
  error: null as string | null,
}))

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => orgContext,
}))

vi.mock("@/components/AccountSwitcher", () => ({
  AccountSwitcher: () => <div data-testid="account-switcher" />,
}))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderGate(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/orgs/:orgId" element={<OrgRouteGate />}>
          <Route index element={<div>ORG INDEX</div>} />
          <Route path="settings" element={<div>ORG SETTINGS</div>} />
        </Route>
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  orgContext.orgs = []
  orgContext.guestOrgs = []
  orgContext.isLoading = false
  orgContext.accessibleProjectsLoading = false
  orgContext.error = null
})

describe("OrgRouteGate (AQU-790 guest orgs)", () => {
  it("admits a member org's index route", () => {
    orgContext.orgs = [{ id: 7 }]
    renderGate("/orgs/7")
    expect(screen.getByText("ORG INDEX")).toBeInTheDocument()
  })

  it("admits a guest org's index route", () => {
    orgContext.guestOrgs = [{ id: 2, name: "Guest Org" }]
    renderGate("/orgs/2")
    expect(screen.getByText("ORG INDEX")).toBeInTheDocument()
  })

  it("redirects a guest away from a member-only sub-route to the guest overview", () => {
    orgContext.guestOrgs = [{ id: 2, name: "Guest Org" }]
    renderGate("/orgs/2/settings")
    expect(screen.queryByText("ORG SETTINGS")).not.toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/2")
    // The index (guest overview) renders after the redirect.
    expect(screen.getByText("ORG INDEX")).toBeInTheDocument()
  })

  it("keeps a member's own sub-routes reachable", () => {
    orgContext.orgs = [{ id: 7 }]
    renderGate("/orgs/7/settings")
    expect(screen.getByText("ORG SETTINGS")).toBeInTheDocument()
  })

  it("waits (no not-found) while the project directory is still loading", () => {
    // Not a member, and guest classification hasn't resolved yet.
    orgContext.accessibleProjectsLoading = true
    renderGate("/orgs/2")
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument()
    expect(screen.getByText("Loading…")).toBeInTheDocument()
  })

  it("shows not-found once the directory has loaded and the org is unknown", () => {
    orgContext.accessibleProjectsLoading = false
    renderGate("/orgs/999")
    expect(screen.getByText("Organization not found")).toBeInTheDocument()
  })

  it("keeps the account switcher on not-found so a cross-tab account switch is visible (FRO-367)", () => {
    orgContext.accessibleProjectsLoading = false
    renderGate("/orgs/999")
    expect(screen.getByTestId("account-switcher")).toBeInTheDocument()
  })

  it("keeps the account switcher while orgs are loading", () => {
    orgContext.isLoading = true
    renderGate("/orgs/7")
    expect(screen.getByTestId("account-switcher")).toBeInTheDocument()
  })
})
