import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgHomeRoute } from "./OrgHomeRoute"
import { OrgProjectsPage } from "./OrgProjectsPage"

// Guest orgs share the member-org `/orgs/:id/projects` table (OrgProjectsPage).
// These pin (a) the index redirect onto that page, (b) scoping to the one guest
// org, (c) exclusion of other foreign-org grants and own-org projects, and
// (d) that rows sit in the projects table without a redundant Shared badge.

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("./OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("./OrgSwitcher", () => ({ OrgSwitcher: () => null }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }))
vi.mock("@/hooks/usePlatformAdmin", () => ({
  usePlatformAdmin: () => ({ isAdmin: false, loading: false }),
}))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    canViewRoster: false,
    hasFetched: true,
    rosterViewMinRole: 600,
    canViewMemberProgress: false,
    memberProgressViewMinRole: 600,
    canEdit: false,
    canEditOrgKeys: false,
    orgProviderKeys: {},
    canExport: false,
    exportMinRole: null,
    settings: {},
    orgRules: [],
    promotionRequests: [],
    canRequestPromotion: false,
    version: 1,
    allowSelfAssignment: false,
    termbaseEditMinRole: 500,
    refresh: vi.fn(async () => null),
    patch: vi.fn(async () => ({ kind: "ok" as const })),
    requestPromotion: vi.fn(async () => ({ kind: "blocked" as const })),
  }),
}))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
}))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: async (...a: unknown[]) => ({
    ok: true as const,
    projects: await fetchAccessibleProjects(...a),
  }),
  projectsResultError: () => new Error("project load failed"),
}))

const getPortfolio = vi.fn()
vi.mock("@/lib/frontier/portfolio", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/frontier/portfolio")>()
  return {
    ...actual,
    getPortfolio: (...a: unknown[]) => getPortfolio(...a),
  }
})

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderGuestOrg(initialEntry = "/orgs/2/projects") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <OrgProvider>
        <Routes>
          <Route path="/orgs/:orgId">
            <Route index element={<OrgHomeRoute />} />
            <Route path="projects" element={<OrgProjectsPage />} />
          </Route>
          <Route path="/projects/:id" element={<div>PROJECT OVERVIEW</div>} />
        </Routes>
        <LocationProbe />
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
  getPortfolio.mockReset()
  listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
  getPortfolio.mockRejectedValue(new Error("guest orgs must not hit the member portfolio"))
})
afterEach(() => vi.clearAllMocks())

describe("guest org projects page", () => {
  it("redirects the guest org index to /projects", async () => {
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p2", name: "Guest Gospel", orgId: 2, orgName: "Sunset Bible", role: { level: 100, name: "viewer", source: "override" } },
    ])

    renderGuestOrg("/orgs/2")

    expect(await screen.findByTestId("org-projects-table")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument()
  })

  it("lists only the active guest org's shared projects in the projects table", async () => {
    fetchAccessibleProjects.mockResolvedValue([
      { id: "own-1", name: "My Org Project", orgId: 1, role: { level: 700, name: "owner", source: "creator" } },
      { id: "p2", name: "Guest Gospel", orgId: 2, orgName: "Sunset Bible", role: { level: 100, name: "viewer", source: "override" } },
      { id: "p3", name: "Other Shared", orgId: 3, orgName: "Other Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    renderGuestOrg()

    const table = await screen.findByTestId("org-projects-table")
    expect(within(table).getByTestId("project-table-name")).toHaveTextContent("Guest Gospel")
    expect(within(table).queryByText("Other Shared")).not.toBeInTheDocument()
    expect(within(table).queryByText("My Org Project")).not.toBeInTheDocument()
    expect(within(table).queryByTestId("project-shared-badge")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /new project/i })).not.toBeInTheDocument()
    await waitFor(() => expect(getPortfolio).not.toHaveBeenCalled())
  })

  it("clicking a guest project row navigates to its project overview", async () => {
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p2", name: "Guest Gospel", orgId: 2, orgName: "Sunset Bible", role: { level: 100, name: "viewer", source: "override" } },
    ])

    renderGuestOrg()

    const table = await screen.findByTestId("org-projects-table")
    fireEvent.click(within(table).getByText("Guest Gospel"))
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p2")
  })
})
