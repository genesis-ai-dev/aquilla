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
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable } from "@/components/ui/data-table"
import { StaffLanePopover } from "./StaffLanePopover"

// The popover links out to the project's invite page (AQU-607), so every
// render needs a Router in context.
function renderPopover(orgId: number | null = 1, laneId?: string) {
  return render(
    <MemoryRouter>
      <StaffLanePopover
        projectId="proj-1"
        lane="es"
        laneId={laneId}
        laneLabel="Spanish"
        projectName="Mark"
        orgId={orgId}
      />
    </MemoryRouter>,
  )
}

// AQU-1448: OverviewLaneTable mounts this popover inside the actions cell of a
// lane row, and lane rows navigate to the workspace on click. Reproduce that
// exact shape — a real DataTable with onRowClick — so the guard is pinned where
// it actually broke, not against a stand-in <div onClick>.
interface LaneRow { lane: string; label: string }

function renderInClickableRow(onRowClick: (row: LaneRow) => void) {
  const columns: ColumnDef<LaneRow>[] = [
    {
      id: "language",
      accessorFn: (l) => l.label,
      header: () => "Language",
      cell: ({ row }) => row.original.label,
    },
    {
      id: "actions",
      enableSorting: false,
      cell: () => (
        <StaffLanePopover projectId="proj-1" lane="es" laneLabel="Spanish" orgId={1} />
      ),
    },
  ]
  return render(
    <MemoryRouter>
      <DataTable
        columns={columns}
        data={[{ lane: "es", label: "Spanish (es)" }]}
        getRowId={(l) => l.lane}
        onRowClick={onRowClick}
      />
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

// AQU-731: the roster's *state* is the thing under test for the
// "Staff does nothing" reports, so every field is overridable per test.
type RosterOverride = Partial<{
  members: typeof mockOrgMembers
  isLoading: boolean
  error: string | null
  rosterHidden: boolean
  rosterAccessDenied: boolean
}>
let mockRoster: RosterOverride = {}

vi.mock("@/hooks/useOrg", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/hooks/useOrg")>()
  return {
    ...mod,
    useOrgMembers: vi.fn(() => ({
      members: mockOrgMembers,
      isLoading: false,
      error: null,
      rosterHidden: false,
      rosterAccessDenied: false,
      ...mockRoster,
      refresh: vi.fn(async () => {}),
      add: vi.fn(async () => null),
      addMany: vi.fn(async () => []),
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
  mockRoster = {}
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

    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

    await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "maria", 300)

    await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
    expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 10, [
      { kind: "lane", value: "es" },
    ])

    await waitFor(() =>
      expect(screen.getByTestId("grant-scope-result")).toHaveTextContent(
        /maria will join as a reviewer on mark, spanish lane only/i,
      ),
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
    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

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

  // AQU-1607: a lane scope is a lane id, so staffing a lane whose id the row
  // knows writes that id — the lane's language cannot say which of two
  // same-language lanes was staffed.
  it("writes the lane's id when the caller passes one, replacing a tag row for it", async () => {
    mockFetchMemberScopes.mockResolvedValue([
      { kind: "lane", value: "es" },
      { kind: "lane", value: "fr" },
    ])

    renderPopover(1, "ln-es")
    openPopover()
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

    await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
    const [, , , scopes] = mockPutMemberScopes.mock.calls[0]
    expect(scopes).toEqual([
      { kind: "lane", value: "fr" },
      { kind: "lane", value: "ln-es" },
    ])
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
    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

    await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).not.toHaveBeenCalled()
  })

  it("lead path: 'Add as lead (unscoped)' POSTs project_lead membership and never PUTs scopes", async () => {
    renderPopover()
    openPopover()
    pickMaria()

    fireEvent.click(screen.getByRole("button", { name: /add as lead — every lane/i }))

    await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "maria", 500)
    expect(mockPutMemberScopes).not.toHaveBeenCalled()

    await waitFor(() =>
      expect(screen.getByTestId("grant-scope-result")).toHaveTextContent(
        /maria will join as a project lead on mark — every lane/i,
      ),
    )
  })

  it("handles the server's 'leads unscopable' 400 gracefully as a success outcome", async () => {
    mockPutMemberScopes.mockRejectedValue(new Error("scopes are for contributor/reviewer roles"))

    renderPopover()
    openPopover()
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

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

  // AQU-731 — "the staff button wasn't even working for me". The popover did
  // open; it just told every operator whose org roster it could not read that
  // their organization was empty, which is indistinguishable from a dead
  // control. Each of these four states must name itself, and none of them may
  // claim the org is empty. The reason is asserted via `data-reason` so the
  // wording can be translated or reworded without silently dropping a state.
  describe("roster is unavailable (the 'Staff does nothing' reports)", () => {
    function blockedRow() {
      return screen.getByTestId("staff-lane-roster-blocked")
    }

    it("says the roster is still loading rather than that the org is empty", () => {
      mockRoster = { members: [], isLoading: true }
      renderPopover()
      openPopover()

      expect(blockedRow()).toHaveAttribute("data-reason", "loading")
      expect(screen.queryByText(/no one in your organization yet/i)).not.toBeInTheDocument()
    })

    it("names org policy when the roster is hidden (AQU-485), not an empty org", () => {
      mockRoster = { members: [], rosterHidden: true }
      renderPopover()
      openPopover()

      expect(blockedRow()).toHaveAttribute("data-reason", "hidden")
      expect(screen.getByText(/hides its member list/i)).toBeInTheDocument()
      expect(screen.queryByText(/no one in your organization yet/i)).not.toBeInTheDocument()
    })

    it("staffs a direct invite onto this lane when the org roster is hidden (AQU-1798)", async () => {
      mockRoster = { members: [], rosterHidden: true }
      mockProjectMembers = [
        {
          userId: 22,
          username: "kean",
          role: { level: 100, name: "viewer", source: "override" },
          secondarySources: [],
        },
      ]
      renderPopover()
      openPopover()

      expect(screen.queryByTestId("staff-lane-roster-blocked")).not.toBeInTheDocument()
      expect(screen.getByTestId("staff-lane-roster-note")).toHaveAttribute("data-reason", "hidden")
      fireEvent.click(screen.getByText("kean"))
      fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

      await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
      expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "kean", 300)
      await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
      expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 22, [
        { kind: "lane", value: "es" },
      ])
    })

    it("tells a non-org-member project admin that they can't see the roster", () => {
      mockRoster = { members: [], rosterAccessDenied: true }
      renderPopover()
      openPopover()

      expect(blockedRow()).toHaveAttribute("data-reason", "no-access")
      expect(screen.getByText(/can’t see this organization’s member list/i)).toBeInTheDocument()
      expect(screen.queryByText(/no one in your organization yet/i)).not.toBeInTheDocument()
    })

    it("surfaces the server's own message when the roster fetch failed", () => {
      mockRoster = { members: [], error: "org roster request failed (429)" }
      renderPopover()
      openPopover()

      expect(blockedRow()).toHaveAttribute("data-reason", "error")
      expect(screen.getByText("org roster request failed (429)")).toBeInTheDocument()
    })

    it("says no org is in context when orgId is null, instead of firing no fetch silently", () => {
      mockRoster = { members: [] }
      renderPopover(null)
      openPopover()

      expect(blockedRow()).toHaveAttribute("data-reason", "no-org")
      expect(screen.queryByText(/no one in your organization yet/i)).not.toBeInTheDocument()
    })

    it("keeps the invite path reachable in every blocked state, so the control is never a dead end", () => {
      mockRoster = { members: [], rosterAccessDenied: true }
      renderPopover()
      openPopover()

      expect(screen.getByRole("link", { name: /invite them to the project/i })).toHaveAttribute(
        "href",
        "/project/proj-1/settings/members",
      )
      // Nothing to type into, so the box must not invite a search that can't run.
      expect(screen.getByPlaceholderText(/search your organization/i)).toBeDisabled()
    })

    it("still reports a genuinely empty org as empty", () => {
      mockRoster = { members: [] }
      renderPopover()
      openPopover()

      expect(screen.queryByTestId("staff-lane-roster-blocked")).not.toBeInTheDocument()
      expect(screen.getByText(/no one in your organization yet/i)).toBeInTheDocument()
    })
  })

  // AQU-1448: the popup is portalled out of the table, but React still bubbles
  // its click events along the React tree — through the row. Without a guard
  // every gesture inside the popover also counted as a row click and navigated
  // to the workspace, unmounting the popover before anyone could be staffed.
  describe("mounted in a clickable row (AQU-1448)", () => {
    it("no gesture inside the popover fires the row's click handler", async () => {
      const onRowClick = vi.fn()
      renderInClickableRow(onRowClick)

      openPopover()
      expect(onRowClick).not.toHaveBeenCalled()

      fireEvent.change(screen.getByPlaceholderText(/search your organization/i), {
        target: { value: "mari" },
      })
      expect(onRowClick).not.toHaveBeenCalled()

      // Picking a name advances to the role step instead of navigating away.
      pickMaria()
      expect(onRowClick).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: /spanish lane only/i })).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))
      await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
      expect(onRowClick).not.toHaveBeenCalled()
    })

    it("still lets a click on the row itself open the workspace", () => {
      const onRowClick = vi.fn()
      renderInClickableRow(onRowClick)

      fireEvent.click(screen.getByText("Spanish (es)"))
      expect(onRowClick).toHaveBeenCalledTimes(1)
      expect(onRowClick).toHaveBeenCalledWith({ lane: "es", label: "Spanish (es)" })
    })
  })
})
