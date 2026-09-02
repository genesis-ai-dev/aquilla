import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { OrgRouteGate } from "./OrgRouteGate"

// AQU-790: guest orgs use the same `/orgs/:orgId` path convention as owned
// orgs. The gate must (a) admit a guest org's index route, (b) wait for the
// project directory before rejecting a possible guest org (so a reload doesn't
// flash not-found), and (c) keep guests out of member-only tool sub-routes.
//
// AQU-1046: with no session the gate must render the canonical signed-out
// workspace (route-preserving sign-in link) instead of classifying membership
// from empty org lists and landing on "Organization not found".

const orgContext = vi.hoisted(() => ({
  orgs: [] as { id: number }[],
  guestOrgs: [] as { id: number; name: string | null }[],
  isLoading: false,
  accessibleProjectsLoading: false,
  error: null as string | null,
}))

type FakeSession = { jwt: string; username: string; createdAt: string } | null
const sessionState = vi.hoisted(() => ({
  session: { jwt: "jwt", username: "alice", createdAt: "x" } as FakeSession,
  loading: false,
}))

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => orgContext,
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => sessionState,
}))

vi.mock("@/components/AccountSwitcher", () => ({
  AccountSwitcher: () => <div data-testid="account-switcher" />,
}))

// SignedOutWorkspace renders the real AppShell; keep the org sidebar and help
// menu out so the gate test stays about the gate, not sidebar data hooks.
vi.mock("./OrgSidebar", () => ({
  OrgSidebar: () => <nav data-testid="org-sidebar" />,
}))
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }))

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
          <Route path="projects" element={<div>ORG PROJECTS</div>} />
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
  sessionState.session = { jwt: "jwt", username: "alice", createdAt: "x" }
  sessionState.loading = false
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

  it("admits a guest org's projects route", () => {
    orgContext.guestOrgs = [{ id: 2, name: "Guest Org" }]
    renderGate("/orgs/2/projects")
    expect(screen.getByText("ORG PROJECTS")).toBeInTheDocument()
  })

  it("redirects a guest away from a member-only sub-route to the guest projects page", () => {
    orgContext.guestOrgs = [{ id: 2, name: "Guest Org" }]
    renderGate("/orgs/2/settings")
    expect(screen.queryByText("ORG SETTINGS")).not.toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/2/projects")
    expect(screen.getByText("ORG PROJECTS")).toBeInTheDocument()
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
    expect(screen.getByRole("status", { name: "Loading organization" })).toBeInTheDocument()
    expect(screen.queryByTestId("account-switcher")).not.toBeInTheDocument()
  })

  it("shows not-found once the directory has loaded and the org is unknown", () => {
    orgContext.accessibleProjectsLoading = false
    renderGate("/orgs/999")
    expect(screen.getByText("Organization not found")).toBeInTheDocument()
    expect(document.querySelector("svg.lucide-search-x")).toBeTruthy()
  })

  it("keeps the account switcher on not-found so a cross-tab account switch is visible (FRO-367)", () => {
    orgContext.accessibleProjectsLoading = false
    renderGate("/orgs/999")
    expect(screen.getByTestId("account-switcher")).toBeInTheDocument()
  })

  it("does not flash a header account switcher while orgs are loading", () => {
    orgContext.isLoading = true
    renderGate("/orgs/7")
    expect(screen.getByRole("status", { name: "Loading organization" })).toBeInTheDocument()
    expect(screen.queryByTestId("account-switcher")).not.toBeInTheDocument()
  })
})

describe("OrgRouteGate (AQU-1046 signed-out)", () => {
  it("renders the signed-out workspace instead of not-found when there is no session", () => {
    // Why: a user who logs out on `/orgs/:id` (e.g. a single-org user bounced
    // there from `/orgs/all`) has empty org lists — that is "signed out", not
    // "no access to organization #N".
    sessionState.session = null
    renderGate("/orgs/1")

    expect(screen.getByText("Sign in to see your workspace")).toBeInTheDocument()
    expect(screen.queryByText("Organization not found")).not.toBeInTheDocument()
    expect(screen.queryByText("ORG INDEX")).not.toBeInTheDocument()
    // The gate's not-found chrome (header account switcher) must not be used.
    expect(screen.queryByTestId("account-switcher")).not.toBeInTheDocument()
    expect(screen.getByTestId("org-sidebar")).toBeInTheDocument()
  })

  it("keeps the current org path in the sign-in link", () => {
    sessionState.session = null
    renderGate("/orgs/1")

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2Forgs%2F1",
    )
  })

  it("preserves a sub-route and query in the sign-in link", () => {
    sessionState.session = null
    renderGate("/orgs/1/settings?tab=members")

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2Forgs%2F1%2Fsettings%3Ftab%3Dmembers",
    )
  })

  it("does not show the signed-out workspace while the session is still loading", () => {
    // Session hydration from IDB: org context is also loading, so the gate
    // must keep its loading state rather than flashing a sign-in prompt.
    sessionState.session = null
    sessionState.loading = true
    orgContext.isLoading = true
    renderGate("/orgs/1")

    expect(screen.getByRole("status", { name: "Loading organization" })).toBeInTheDocument()
    expect(screen.queryByText("Sign in to see your workspace")).not.toBeInTheDocument()
    expect(screen.queryByText("Organization not found")).not.toBeInTheDocument()
  })

  it("still shows not-found for a signed-in user without access", () => {
    // Default session is signed in; empty org lists mean a real access miss.
    renderGate("/orgs/999")

    expect(screen.getByText("Organization not found")).toBeInTheDocument()
    expect(screen.queryByText("Sign in to see your workspace")).not.toBeInTheDocument()
  })
})
