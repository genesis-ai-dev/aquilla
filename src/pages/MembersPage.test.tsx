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

// All named exports from @/lib/frontier/orgs used by MembersPage,
// MembersPageContent, useOrgMembers, useOrgInvites, and useAccessibleProjects.
//
// listMyOrgs returns "Come and See" (org 42) — the active-org data.
// getOrCreateMyOrg returns a DIFFERENT org ("Legacy Org", id 99) — owned-org data.
// The test asserts "Come and See" appears, which only happens if MembersPage
// reads from the active org (useActiveOrg / listMyOrgs), not the owned org
// (useOrg / getOrCreateMyOrg).
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [
    { id: 42, name: "Come and See", role: { level: 700, name: "owner" } },
  ]),
  listOrgMembers: vi.fn(async () => []),
  addOrgMember: vi.fn(async () => null),
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
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
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

beforeEach(() => localStorage.clear())
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
  // The whole point of AQU-485 is that a below-floor caller must not see the
  // roster OR be able to infer it's merely "empty" — those are different
  // facts (hidden vs. zero members) and conflating them defeats the feature.
  it("renders a 'Roster hidden' state instead of an empty member list when rosterHidden is true", async () => {
    const { useOrgMembers } = await import("@/hooks/useOrg")
    vi.mocked(useOrgMembers).mockReturnValue({
      members: [],
      isLoading: false,
      error: null,
      rosterHidden: true,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
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
            </Routes>
          </OrgProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText(/roster hidden/i)).toBeInTheDocument())
    // Must not render the roster/add-member editing surface (the username
    // typeahead used to add a direct org member) — that would itself imply
    // an editable roster the caller isn't supposed to see.
    expect(screen.queryByPlaceholderText(/aquilla username/i)).not.toBeInTheDocument()
    // The "Project access" per-member breakdown section must also be absent
    // — it would leak roster membership even if the top roster list is
    // hidden. Match the section heading exactly (a page description sentence
    // elsewhere mentions "project access" in unrelated prose).
    expect(screen.queryByRole("heading", { name: /^project access$/i })).not.toBeInTheDocument()
  })
})

describe("MembersPage — AQU-538 §3.4 matrix tab", () => {
  // MembersMatrixView existed but was mounted nowhere. It's now a tab on
  // this page: Roster is the default (byte-identical to today), Matrix is
  // reachable both by clicking the tab and by deep-linking ?tab=matrix.
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
      expect(screen.getByRole("heading", { name: /^roster$/i })).toBeInTheDocument(),
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
      expect(screen.getByRole("heading", { name: /^roster$/i })).toBeInTheDocument(),
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
