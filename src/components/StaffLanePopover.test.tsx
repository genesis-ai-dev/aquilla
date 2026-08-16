// AQU-538 §3.4 — StaffLanePopover: the one-gesture staffing control.
//
// Pins under test:
//   - Happy path: picking a not-yet-member and confirming issues POST
//     membership at the picked role, then PUT scopes merged with whatever
//     that user already had (never clobbering other lanes/files).
//   - Existing-member: if the picked person already holds >= the picked
//     role, the POST membership call is skipped (never a downgrade) but the
//     scope PUT still runs.
//   - Lead path: "Add as lead (unscoped)" issues membership at project_lead
//     and never calls the scopes PUT at all (leads can't be scoped).
//   - Graceful handling of the server's "leads unscopable" 400: if the scope
//     PUT is rejected because the target's effective role is already lead+,
//     the popover reports success ("already leads … no lane scope needed"),
//     not an error.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { StaffLanePopover } from "./StaffLanePopover"

// The popover links out to the project's invite page (AQU-607), so every
// render needs a Router in context.
function renderPopover() {
  return render(
    <MemoryRouter>
      <StaffLanePopover projectId="proj-1" lane="es" laneLabel="Spanish" orgId={1} />
    </MemoryRouter>,
  )
}

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt-pm", username: "pm", createdAt: "x" },
    loading: false,
  }),
}))

const mockOrgMembers = [
  { userId: 10, username: "maria", role: { level: 400, name: "contributor" } },
  { userId: 11, username: "mark", role: { level: 400, name: "contributor" } },
]

vi.mock("@/hooks/useOrg", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/hooks/useOrg")>()
  return {
    ...mod,
    useOrgMembers: vi.fn(() => ({
      members: mockOrgMembers,
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      remove: vi.fn(async () => {}),
      listMemberProjects: vi.fn(async () => []),
    })),
  }
})

// Controlled per-test via mockProjectMembers.
let mockProjectMembers: Array<{ userId: number; username: string; role: { level: number; name: string; source: "override" }; secondarySources: [] }> = []
const mockRefreshProjectMembers = vi.fn(async () => {})

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: vi.fn(() => ({
    members: mockProjectMembers,
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: mockRefreshProjectMembers,
    add: vi.fn(async () => null),
    remove: vi.fn(async () => {}),
    changeRole: vi.fn(async () => null),
  })),
}))

type Scope = { kind: "lane" | "file"; value: string }

// vi.mock factories are hoisted above every top-level statement, so the mock
// fns they reference must be created via vi.hoisted (a plain `const` here
// would still be in the temporal dead zone when the factory runs).
const { mockAddProjectMember, mockFetchMemberScopes, mockPutMemberScopes } = vi.hoisted(() => ({
  mockAddProjectMember: vi.fn(
    async (_jwt: string, _projectId: string, _username: string, _role: number) => ({}),
  ),
  mockFetchMemberScopes: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number) => [] as Scope[],
  ),
  mockPutMemberScopes: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number, scopes: Scope[]) => scopes,
  ),
}))

vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/frontier/members")>()
  return {
    ...mod,
    addProjectMember: mockAddProjectMember,
  }
})

vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopes: mockFetchMemberScopes,
  putMemberScopes: mockPutMemberScopes,
}))

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: /staff spanish/i }))
}

function pickMaria() {
  fireEvent.click(screen.getByText("maria"))
}

beforeEach(() => {
  mockProjectMembers = []
  mockAddProjectMember.mockClear()
  mockFetchMemberScopes.mockClear()
  mockFetchMemberScopes.mockResolvedValue([])
  mockPutMemberScopes.mockClear()
  mockPutMemberScopes.mockImplementation(async (_jwt, _projectId, _userId, scopes) => scopes)
  mockRefreshProjectMembers.mockClear()
})

describe("StaffLanePopover", () => {
  it("happy path: POSTs membership at the picked role then PUTs merged scopes", async () => {
    renderPopover()
    openPopover()
    pickMaria()

    fireEvent.click(screen.getByRole("button", { name: /add to spanish/i }))

    await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "maria", 300)

    await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
    expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 10, [
      { kind: "lane", value: "es" },
    ])

    await waitFor(() =>
      expect(screen.getByText(/maria is now reviewer on spanish/i)).toBeInTheDocument(),
    )
  })

  it("merges the new lane scope with existing scopes instead of clobbering them", async () => {
    mockFetchMemberScopes.mockResolvedValue([
      { kind: "lane", value: "fr" },
      { kind: "file", value: "GEN" },
    ])

    renderPopover()
    openPopover()
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /add to spanish/i }))

    await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
    const [, , , scopes] = mockPutMemberScopes.mock.calls[0]
    expect(scopes).toEqual(
      expect.arrayContaining([
        { kind: "lane", value: "fr" },
        { kind: "file", value: "GEN" },
        { kind: "lane", value: "es" },
      ]),
    )
    expect(scopes).toHaveLength(3)
  })

  it("skips the membership POST when the person already holds >= the picked role", async () => {
    mockProjectMembers = [
      {
        userId: 10,
        username: "maria",
        role: { level: 400, name: "contributor", source: "override" },
        secondarySources: [],
      },
    ]

    renderPopover()
    openPopover()
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /add to spanish/i }))

    await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).not.toHaveBeenCalled()
  })

  it("lead path: 'Add as lead (unscoped)' POSTs project_lead membership and never PUTs scopes", async () => {
    renderPopover()
    openPopover()
    pickMaria()

    fireEvent.click(screen.getByRole("button", { name: /add as lead \(unscoped\)/i }))

    await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "maria", 500)
    expect(mockPutMemberScopes).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByText(/maria is now a lead/i)).toBeInTheDocument())
  })

  it("handles the server's 'leads unscopable' 400 gracefully as a success outcome", async () => {
    mockPutMemberScopes.mockRejectedValue(new Error("scopes are for contributor/reviewer roles"))

    renderPopover()
    openPopover()
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /add to spanish/i }))

    await waitFor(() =>
      expect(screen.getByText(/already leads this project/i)).toBeInTheDocument(),
    )
    // Not treated as an error state.
    expect(screen.queryByText(/scopes are for contributor\/reviewer roles/i)).not.toBeInTheDocument()
  })

  it("filters the org roster by the search query", async () => {
    renderPopover()
    openPopover()
    fireEvent.change(screen.getByPlaceholderText(/search your organization/i), {
      target: { value: "mari" },
    })

    expect(screen.getByText("maria")).toBeInTheDocument()
    expect(screen.queryByText("mark")).not.toBeInTheDocument()
  })

  // AQU-607: the old failure mode was a silent dead-end — searching for
  // someone outside your org just showed "No matches" with no way forward.
  // The picker must always offer the external-contributor path (invite link).
  it("always offers the invite path to the project members page for outside-org adds", () => {
    renderPopover()
    openPopover()

    const invite = screen.getByRole("link", { name: /invite them to the project/i })
    expect(invite).toHaveAttribute("href", "/project/proj-1/settings/members")
  })
})
