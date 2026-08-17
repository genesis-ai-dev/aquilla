import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSidebar } from "./OrgSidebar"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("./OrgSwitcher", () => ({ OrgSwitcher: () => null }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }))
const platformAdmin = vi.hoisted(() => ({ isAdmin: false }))
vi.mock("@/hooks/usePlatformAdmin", () => ({
  usePlatformAdmin: () => ({ isAdmin: platformAdmin.isAdmin, loading: false }),
}))

const rosterSettings = vi.hoisted(() => ({ canViewRoster: true }))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    canViewRoster: rosterSettings.canViewRoster,
    hasFetched: true,
    rosterViewMinRole: 600,
    canViewMemberProgress: true,
    memberProgressViewMinRole: 600,
    canEdit: true,
    canEditOrgKeys: true,
    orgProviderKeys: {},
    canExport: true,
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
  fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

function renderSidebar(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OrgProvider>
        <OrgSidebar />
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
  rosterSettings.canViewRoster = true
})
afterEach(() => vi.clearAllMocks())

describe("OrgSidebar — shared grants live on /orgs/all, not a peer nav item", () => {
  it("does not render a Shared with you link when the user has cross-org grants", async () => {
    listMyOrgs.mockResolvedValue([])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Genesis Draft", gitlabProjectId: null, orgId: 99, role: { level: 400, name: "contributor", source: "override" } },
    ])

    renderSidebar("/orgs/all")

    const overview = await screen.findByRole("link", { name: "Overview" })
    expect(overview).toHaveAttribute("href", "/orgs/all")
    expect(screen.queryByRole("link", { name: "Shared with you" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Genesis Draft" })).not.toBeInTheDocument()
  })

  it("does not render Shared with you when all accessible projects are in the user's org", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "In-org project", gitlabProjectId: null, orgId: 1, role: { level: 700, name: "owner", source: "org" } },
    ])

    renderSidebar("/orgs/1")

    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalled())
    expect(screen.queryByText("Shared with you")).not.toBeInTheDocument()
  })
})

describe("OrgSidebar in a guest org (AQU-790)", () => {
  it("hides member-only nav and keeps Projects for this guest org", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Acme", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "pg", name: "Shared Proj", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
      { id: "ph", name: "Other Shared", orgId: 3, orgName: "Other Guest", role: { level: 100, name: "viewer", source: "override" } },
    ])

    render(
      <MemoryRouter initialEntries={["/orgs/2"]}>
        <OrgProvider>
          <OrgSidebar />
        </OrgProvider>
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/orgs/2"),
    )
    expect(screen.queryByRole("link", { name: "Shared with you" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Members" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Archived" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Teams" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Assigned to me" })).not.toBeInTheDocument()
  })
})

describe("OrgSidebar all-organizations scope", () => {
  it("shows Overview (not Projects) as the sole portfolio home link", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
      { id: 2, name: "Beta", role: { level: 700, name: "owner" } },
    ])
    fetchAccessibleProjects.mockResolvedValue([])

    renderSidebar("/orgs/all")

    const overview = await screen.findByRole("link", { name: "Overview" })
    expect(overview).toHaveAttribute("href", "/orgs/all")
    expect(overview).toHaveAttribute("data-tour", "nav-overview")
    expect(screen.queryByRole("link", { name: "Projects" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Teams" })).not.toBeInTheDocument()
  })
})

describe("OrgSidebar Members nav — AQU-485 roster visibility", () => {
  it("hides Members when the caller is below the roster floor, even if they are an org owner", async () => {
    rosterSettings.canViewRoster = false
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([])

    renderSidebar("/orgs/1")

    await waitFor(() => expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument())
    expect(screen.queryByRole("link", { name: "Members" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Archived" })).toBeInTheDocument()
  })

  it("shows Members when the roster floor allows it", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([])

    renderSidebar("/orgs/1")

    expect(await screen.findByRole("link", { name: "Members" })).toHaveAttribute("href", "/orgs/1/members")
  })
})
