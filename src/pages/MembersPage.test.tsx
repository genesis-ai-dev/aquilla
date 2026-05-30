import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
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
}))

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("MembersPage active-org", () => {
  it("renders members for the active org (42)", async () => {
    render(
      <MemoryRouter>
        <OrgProvider>
          <MembersPage />
        </OrgProvider>
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByText("Come and See")).toBeInTheDocument(),
    )
  })
})
