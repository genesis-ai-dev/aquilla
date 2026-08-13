import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { OrgHome } from "./OrgHome"

// AQU-864: `/orgs/all` aggregates the portfolios of orgs the caller is a MEMBER
// of, so it only has something to show at 2+ memberships. Below that it fell
// through to the single-org dashboard with no org in scope and painted "Your
// organization is ready" — 0/0/0 stats, no create dialog (it needs an org id)
// and an "Invite your team" button wired to a null org. `/` resumes to
// `/orgs/all`, so a user whose access is entirely project-level landed on a
// page where nothing was clickable and none of their projects were reachable.
//
// These assert the landing decision through the component, which is the level
// the bug escaped at — the resolver's own cases live in
// src/lib/navigation/all-orgs-landing.test.ts.

const orgContext = vi.hoisted(() => ({
  activeOrg: null as { id: number; name: string } | null,
  activeOrgId: null as number | null,
  isAllOrgs: false,
  orgs: [] as { id: number; name: string }[],
  accessibleProjects: [] as { id: string }[],
  accessibleProjectsLoading: false,
  accessibleProjectsError: null as string | null,
  isLoading: false,
  error: null as string | null,
  setActiveOrg: vi.fn(),
  refresh: vi.fn(async () => []),
  refreshAccessibleProjects: vi.fn(async () => []),
  retryOrgLoad: vi.fn(async () => {}),
}))

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => orgContext,
  useActiveOrgOptional: () => orgContext,
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "test-jwt", username: "josseline" },
    loading: false,
  }),
}))

// The dashboard chrome is irrelevant to the landing decision and drags in the
// whole sidebar/settings stack; stub it so these stay focused unit tests.
vi.mock("./OrgSidebar", () => ({ OrgSidebar: () => <nav /> }))
vi.mock("./OrgBreadcrumb", () => ({ OrgBreadcrumb: () => <div /> }))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    hasFetched: true,
    memberProgressViewMinRole: 0,
    allowSelfAssignment: false,
    patch: vi.fn(async () => {}),
  }),
  canEditRosterProgressFloor: () => false,
}))
vi.mock("@/lib/sync/invites", () => ({ listMyPendingInvites: vi.fn(async () => []) }))
vi.mock("@/lib/frontier/portfolio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontier/portfolio")>()),
  getPortfolio: vi.fn(async () => []),
  getPortfolios: vi.fn(async () => []),
}))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderAllOrgs() {
  return render(
    <MemoryRouter initialEntries={["/orgs/all"]}>
      <Routes>
        <Route path="/orgs/all" element={<OrgHome />} />
        <Route path="/orgs/:orgId" element={<div>ORG HOME</div>} />
        <Route path="/shared" element={<div>SHARED WITH YOU</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  orgContext.activeOrg = null
  orgContext.activeOrgId = null
  orgContext.isAllOrgs = false
  orgContext.orgs = []
  orgContext.accessibleProjects = []
  orgContext.accessibleProjectsLoading = false
  orgContext.accessibleProjectsError = null
  orgContext.isLoading = false
  orgContext.error = null
  orgContext.retryOrgLoad.mockClear()
})

describe("OrgHome — /orgs/all landing (AQU-864)", () => {
  it("routes a caller with project access but no org membership to Shared with you", () => {
    orgContext.orgs = []
    orgContext.accessibleProjects = [{ id: "p1" }, { id: "p2" }]

    renderAllOrgs()

    expect(screen.getByTestId("location")).toHaveTextContent("/shared")
    expect(screen.getByText("SHARED WITH YOU")).toBeInTheDocument()
    expect(screen.queryByText(/your organization is ready/i)).not.toBeInTheDocument()
  })

  it("routes a single-membership caller to that org's home", () => {
    orgContext.orgs = [{ id: 7, name: "Biblica ETT" }]
    orgContext.accessibleProjects = [{ id: "p1" }]

    renderAllOrgs()

    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/7")
    expect(screen.getByText("ORG HOME")).toBeInTheDocument()
  })

  it("shows an error with a retry when the org list failed to load", () => {
    // A failed fetch leaves `orgs` empty exactly like a genuine zero — the page
    // must not present that as an empty workspace.
    orgContext.error = "Failed to fetch"

    renderAllOrgs()

    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/all")
    expect(screen.getByTestId("org-load-error")).toBeInTheDocument()
    expect(screen.getByText(/couldn’t load your organizations/i)).toBeInTheDocument()
    expect(screen.queryByText(/your organization is ready/i)).not.toBeInTheDocument()

    // AQU-882: retry must re-issue the org fetch AND the dependent
    // project-directory fetch — the resolver reads `accessibleProjects` too.
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(orgContext.retryOrgLoad).toHaveBeenCalledTimes(1)
  })

  it("shows the error rather than the empty state when the project directory failed at zero memberships", () => {
    // AQU-883: guest orgs and shared projects come only from the directory, so
    // its failure makes "no access at all" unknown — never the create-your-org
    // dead end. The retry re-issues both fetches.
    orgContext.accessibleProjectsError = "Failed to fetch"

    renderAllOrgs()

    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/all")
    expect(screen.getByTestId("org-load-error")).toBeInTheDocument()
    expect(screen.queryByTestId("no-organizations-empty")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(orgContext.retryOrgLoad).toHaveBeenCalledTimes(1)
  })

  it("keeps the create-your-organization empty state for a caller with no access at all", () => {
    // The genuine new-user case: no memberships, no shared projects. No
    // redirect, and the one offered action must actually be actionable.
    renderAllOrgs()

    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/all")
    expect(screen.getByTestId("no-organizations-empty")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /create organization/i })).toBeInTheDocument()
    expect(screen.queryByText(/your organization is ready/i)).not.toBeInTheDocument()
  })
})
