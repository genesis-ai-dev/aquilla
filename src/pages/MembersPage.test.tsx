import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { OrgProvider } from "@/context/OrgContext"
import { MembersPage } from "./MembersPage"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt", username: "anna", createdAt: "x" },
    loading: false,
  }),
}))

const rosterSettings = vi.hoisted(() => ({ canViewRoster: true }))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    settings: {},
    orgRules: [],
    promotionRequests: [],
    canRequestPromotion: false,
    version: 1,
    hasFetched: true,
    canEdit: true,
    canEditOrgKeys: true,
    orgProviderKeys: {},
    canExport: true,
    exportMinRole: null,
    canViewRoster: rosterSettings.canViewRoster,
    rosterViewMinRole: 600,
    canViewMemberProgress: true,
    memberProgressViewMinRole: 600,
    allowSelfAssignment: false,
    termbaseEditMinRole: 500,
    languageEditMinRole: 600,
    refresh: vi.fn(async () => null),
    patch: vi.fn(async () => ({ kind: "ok" as const })),
    requestPromotion: vi.fn(async () => ({ kind: "blocked" as const })),
  }),
}))

// All named exports from @/lib/frontier/orgs used by MembersPage,
// MembersPageContent, useOrgMembers, useOrgInvites, and useAccessibleProjects.
//
// listMyOrgs returns "Come and See" (org 42) — the active-org data.
// getOrCreateMyOrg returns a DIFFERENT org ("Legacy Org", id 99) — owned-org data.
// The test asserts "Come and See" appears, which only happens if MembersPage
// reads from the active org (useActiveOrg / listMyOrgs), not the owned org
// (useOrg / getOrCreateMyOrg).
const listMyOrgs = vi.fn(async (_jwt?: string) => [
  { id: 42, name: "Come and See", role: { level: 700, name: "owner" } },
])
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (jwt?: string) => listMyOrgs(jwt),
  listOrgMembers: vi.fn(async () => []),
  addOrgMember: vi.fn(async () => null),
  addOrgMembers: vi.fn(async () => []),
  removeOrgMember: vi.fn(async () => undefined),
  listOrgMemberProjects: vi.fn(async () => []),
  listPendingOrgInvites: vi.fn(async () => null),
  revokeProjectInvite: vi.fn(async () => true),
  // Deliberately different name so the test fails if MembersPage still reads
  // the owned org via useOrg() / getOrCreateMyOrg.
  getOrCreateMyOrg: vi.fn(async () => ({
    id: 99,
    name: "Legacy Org",
    role: { level: 700, name: "owner" },
  })),
}))

// Mock hooks that make network calls so MembersPageContent renders without
// a real network.
vi.mock("@/hooks/useOrg", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/hooks/useOrg")>()
  return {
    ...mod,
    useOrgMembers: vi.fn(() => ({
      members: [],
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })),
  }
})

vi.mock("@/hooks/useOrgInvites", () => ({
  useOrgInvites: vi.fn(() => ({
    invites: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    revoke: vi.fn(async () => false),
  })),
}))

vi.mock("@/hooks/useAccessibleProjects", () => ({
  useAccessibleProjects: vi.fn(() => ({
    projects: [],
    isLoading: false,
    refresh: vi.fn(async () => {}),
  })),
  // AQU-474: OrgSidebar's "Shared with you" nav section uses this hook.
  useProjectsForNavigation: vi.fn(() => ({
    projects: [],
    isLoading: false,
    refresh: vi.fn(async () => {}),
  })),
}))

beforeEach(() => {
  localStorage.clear()
  rosterSettings.canViewRoster = true
  vi.mocked(listMyOrgs).mockResolvedValue([
    { id: 42, name: "Come and See", role: { level: 700, name: "owner" } },
  ])
})
afterEach(() => vi.restoreAllMocks())

describe("MembersPage active-org", () => {
  it("renders members for the active org (42)", async () => {
    // QueryClientProvider: the org shell's AccountSwitcher reaches useAccounts,
    // which clears the React Query cache on account switch (AQU-212).
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/orgs/42/members"]}>
          <OrgProvider>
            <Routes>
              <Route path="/orgs/:orgId/members" element={<MembersPage />} />
              <Route path="/orgs/:orgId/members/matrix" element={<MembersPage />} />
            </Routes>
          </OrgProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    // The active org's name now appears in more than one place (the OrgSidebar
    // switcher + the "People in <org>" heading) since MembersPage renders inside
    // the org shell — so assert ≥1 match rather than exactly one. The point of
    // this test is active-vs-owned: "Come and See" (42, from listMyOrgs) shows
    // and "Legacy Org" (99, from getOrCreateMyOrg) does NOT.
    await waitFor(() =>
      expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0),
    )
    expect(screen.queryByText("Legacy Org")).not.toBeInTheDocument()
  })
})

describe("MembersPage — AQU-485 roster visibility", () => {
  // Below-floor callers must not see the roster, an empty list, or a
  // "hidden" disclosure — the Members page itself is absent.
  it("redirects to the org overview when the roster is hidden by policy", async () => {
    rosterSettings.canViewRoster = false
    const { useOrgMembers } = await import("@/hooks/useOrg")
    vi.mocked(useOrgMembers).mockReturnValueOnce({
      members: [],
      isLoading: false,
      error: null,
      rosterHidden: true,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/orgs/42/members"]}>
          <OrgProvider>
            <Routes>
              <Route path="/orgs/:orgId/members" element={<MembersPage />} />
              <Route path="/orgs/:orgId/members/matrix" element={<MembersPage />} />
              <Route path="/orgs/:orgId/overview" element={<div>org overview</div>} />
            </Routes>
          </OrgProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText("org overview")).toBeInTheDocument())
    expect(screen.queryByText(/roster hidden/i)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/search by name or email/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId("org-members-table")).not.toBeInTheDocument()
  })
})

describe("MembersPage — AQU-538 §3.4 matrix tab", () => {
  // MembersMatrixView is a tab on this page: Roster is the default Teams-style
  // table, Matrix is reachable both by clicking the tab and by deep-linking.
  it("renders the Roster tab by default", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/orgs/42/members"]}>
          <OrgProvider>
            <Routes>
              <Route path="/orgs/:orgId/members" element={<MembersPage />} />
              <Route path="/orgs/:orgId/members/matrix" element={<MembersPage />} />
            </Routes>
          </OrgProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^roster$/i })).toBeInTheDocument(),
    )
    expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument()
  })

  it("switches to the Matrix tab (MembersMatrixView) on click", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/orgs/42/members"]}>
          <OrgProvider>
            <Routes>
              <Route path="/orgs/:orgId/members" element={<MembersPage />} />
              <Route path="/orgs/:orgId/members/matrix" element={<MembersPage />} />
            </Routes>
          </OrgProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^roster$/i })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("tab", { name: /matrix/i }))

    // No accessible projects in this test's mocks → MembersMatrixView's
    // empty state, which is proof the component actually mounted.
    await waitFor(() => expect(screen.getByText(/no projects yet/i)).toBeInTheDocument())
  })

  it("deep-links directly to the Matrix tab via ?tab=matrix", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/orgs/42/members/matrix"]}>
          <OrgProvider>
            <Routes>
              <Route path="/orgs/:orgId/members" element={<MembersPage />} />
              <Route path="/orgs/:orgId/members/matrix" element={<MembersPage />} />
            </Routes>
          </OrgProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText(/no projects yet/i)).toBeInTheDocument())
  })
})

describe("MembersPage — Teams-style roster table", () => {
  function renderMembers() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/orgs/42/members"]}>
          <OrgProvider>
            <Routes>
              <Route path="/orgs/:orgId/members" element={<MembersPage />} />
              <Route path="/orgs/:orgId/members/matrix" element={<MembersPage />} />
            </Routes>
          </OrgProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it("renders members in a searchable table with email and role", async () => {
    const { useOrgMembers } = await import("@/hooks/useOrg")
    vi.mocked(useOrgMembers).mockReturnValue({
      members: [
        {
          userId: 1,
          username: "anna",
          email: "anna@example.com",
          role: { level: 700, name: "owner" },
          lastActiveAt: null,
        },
        {
          userId: 2,
          username: "ben",
          email: "ben@example.com",
          role: { level: 400, name: "contributor" },
          lastActiveAt: null,
        },
      ],
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })

    renderMembers()
    await waitFor(() => expect(screen.getByTestId("org-members-table")).toBeInTheDocument())
    expect(screen.getByPlaceholderText(/search by name or email/i)).toBeInTheDocument()
    expect(screen.getByText("anna")).toBeInTheDocument()
    expect(screen.getByText("ben")).toBeInTheDocument()
    expect(screen.getByText("anna@example.com")).toBeInTheDocument()
    expect(screen.getByText("Contributor")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /add a member/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /add to projects/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /actions for ben/i })).toBeInTheDocument()
    expect(screen.queryByText(/^remove$/i)).not.toBeInTheDocument()
  })

  it("keeps Remove in the row menu, disabled for a non-owner", async () => {
    vi.mocked(listMyOrgs).mockResolvedValue([
      { id: 42, name: "Come and See", role: { level: 400, name: "contributor" } },
    ])
    const { useOrgMembers } = await import("@/hooks/useOrg")
    vi.mocked(useOrgMembers).mockReturnValue({
      members: [
        {
          userId: 2,
          username: "ben",
          email: "ben@example.com",
          role: { level: 400, name: "contributor" },
          lastActiveAt: null,
        },
      ],
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })

    renderMembers()
    await waitFor(() => expect(screen.getByTestId("org-members-table")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /add a member/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /add to projects/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/^remove$/i)).not.toBeInTheDocument()

    const row = screen.getByText("ben").closest("tr")!
    fireEvent.contextMenu(row)
    const fromContext = await screen.findByRole("menuitem", { name: /remove ben — owners only/i })
    expect(fromContext).toHaveAttribute("aria-disabled", "true")
    fireEvent.keyDown(document, { key: "Escape" })

    fireEvent.click(screen.getByRole("button", { name: /actions for ben/i }))
    const fromMenu = await screen.findByRole("menuitem", { name: /remove ben — owners only/i })
    expect(fromMenu).toHaveAttribute("aria-disabled", "true")
  })

  it("shows Add to projects when the caller can grant membership on a project", async () => {
    const { useAccessibleProjects } = await import("@/hooks/useAccessibleProjects")
    vi.mocked(useAccessibleProjects).mockReturnValue({
      projects: [
        {
          id: "p1",
          name: "John",
          gitlabProjectId: null,
          role: { level: 600, name: "maintainer", source: "grant" },
        },
      ],
      isLoading: false,
      error: null,
      refresh: vi.fn(async () => {}),
    })
    const { useOrgMembers } = await import("@/hooks/useOrg")
    vi.mocked(useOrgMembers).mockReturnValue({
      members: [
        {
          userId: 1,
          username: "anna",
          email: "anna@example.com",
          role: { level: 700, name: "owner" },
          lastActiveAt: null,
        },
      ],
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })

    renderMembers()
    await waitFor(() => expect(screen.getByRole("button", { name: /add to projects/i })).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /add to projects/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: /add a member/i })).toBeInTheDocument()
  })

  it("hides Add a member but keeps Add to projects for a non-owner with project grants", async () => {
    vi.mocked(listMyOrgs).mockResolvedValue([
      { id: 42, name: "Come and See", role: { level: 400, name: "contributor" } },
    ])
    const { useAccessibleProjects } = await import("@/hooks/useAccessibleProjects")
    vi.mocked(useAccessibleProjects).mockReturnValue({
      projects: [
        {
          id: "p1",
          name: "John",
          gitlabProjectId: null,
          role: { level: 600, name: "maintainer", source: "grant" },
        },
      ],
      isLoading: false,
      error: null,
      refresh: vi.fn(async () => {}),
    })
    const { useOrgMembers } = await import("@/hooks/useOrg")
    vi.mocked(useOrgMembers).mockReturnValue({
      members: [
        {
          userId: 2,
          username: "ben",
          email: "ben@example.com",
          role: { level: 400, name: "contributor" },
          lastActiveAt: null,
        },
      ],
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })

    renderMembers()
    await waitFor(() => expect(screen.getByRole("button", { name: /add to projects/i })).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /add to projects/i })).toBeEnabled()
    expect(screen.queryByRole("button", { name: /add a member/i })).not.toBeInTheDocument()
  })

  it("opens the add-member dialog from the toolbar", async () => {
    const { useOrgMembers } = await import("@/hooks/useOrg")
    vi.mocked(useOrgMembers).mockReturnValue({
      members: [
        {
          userId: 1,
          username: "anna",
          email: "anna@example.com",
          role: { level: 700, name: "owner" },
          lastActiveAt: null,
        },
      ],
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })

    renderMembers()
    await waitFor(() => expect(screen.getByRole("button", { name: /add a member/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /add a member/i }))
    expect(screen.getByRole("dialog", { name: /add a member/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /add members/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /invite by email/i })).toBeInTheDocument()
  })
})
