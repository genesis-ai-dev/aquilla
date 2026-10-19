// AQU-538 §3.4 — StaffLanePopover: the one-gesture staffing control.
//
// Pins under test:
//   - Happy path: picking a not-yet-member and confirming issues POST
//     membership at the picked role, then PUT scopes merged with whatever
//     that user already had (never clobbering other lanes/files).
//   - Existing-member: if the picked person already holds >= the picked
//     role, the POST membership call is skipped (never a downgrade) but the
//     scope PUT still runs.
//   - AQU-2004: there is no lead path here at all — no "Leads see all
//     languages" note, no "Add as lead" button, and no catalog in any locale
//     still carrying those retired messages.
//   - AQU-2027: maintainers and above can't be lane-limited. Someone the
//     roster shows at 600+ gets a note and no Add; if the scope PUT is still
//     refused for that reason (the route's real LANE_SCOPE_ABOVE_CEILING_ERROR),
//     the popover shows the same note, not the raw server error. Someone
//     already on the project at or above the picked role keeps their role,
//     and the sentence says so ("stays a Project lead").
//   - AQU-1998 Remove: the popover lists who is already scoped to the lane and
//     takes one of them off it — their other lanes and file limits written
//     through untouched, a lane-limited project lead listed like anyone else
//     (AQU-2027), maintainers never, and the person's LAST lane guarded (an
//     empty lane list means every lane, so that removal would widen their
//     access).
//   - AQU-1999 Remove, decided: the last lane stays guarded, and a removal
//     from a lane the person holds open assignments in closes that work —
//     after a confirmation naming the count, never silently, and never before
//     the last-lane guard has had its say. A lane with nothing open is still
//     one press, and a failed assignment read refuses the removal rather than
//     reading "couldn't tell" as "nothing open".

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable } from "@/components/ui/data-table"
import { StaffLanePopover } from "./StaffLanePopover"
import { CATALOGS } from "@/lib/i18n/messages"
import { LANE_SCOPE_ABOVE_CEILING_ERROR } from "@/lib/lanes/scope-ids"

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
/** AQU-1999: one open assignment row, as the lane-assignments read returns it. */
type LaneAssignment = { assignmentId: string; fileId: string; scopeLabel: string }

const {
  mockAddProjectMember,
  mockFetchMemberScopes,
  mockPutMemberScopes,
  mockFetchMemberLaneAssignments,
  mockUnassignAssignment,
} = vi.hoisted(() => ({
  mockAddProjectMember: vi.fn(
    async (_jwt: string, _projectId: string, _username: string, _role: number) => ({}),
  ),
  mockFetchMemberScopes: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number) => [] as Scope[],
  ),
  mockPutMemberScopes: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number, scopes: Scope[]) => scopes,
  ),
  mockFetchMemberLaneAssignments: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number, _lane: string) =>
      [] as LaneAssignment[] | null,
  ),
  mockUnassignAssignment: vi.fn(async (_args: {
    jwt: string
    projectId: string
    fileId: string
    author: string
    assignmentId: string
  }) => {}),
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
  fetchMemberLaneAssignments: mockFetchMemberLaneAssignments,
}))

vi.mock("@/lib/sync/assignments", () => ({
  unassignAssignment: mockUnassignAssignment,
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
  mockFetchMemberLaneAssignments.mockClear()
  mockFetchMemberLaneAssignments.mockResolvedValue([])
  mockUnassignAssignment.mockClear()
  mockUnassignAssignment.mockImplementation(async () => {})
  mockRefreshProjectMembers.mockClear()
})

describe("StaffLanePopover", () => {
  it("happy path: POSTs membership at the picked role then PUTs merged scopes", async () => {
    renderPopover()
    openPopover()
    pickMaria()

    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

    await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "maria", 300, {
      scopeLanes: ["es"],
    })

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

  // AQU-2004 — the popover used to end in a dashed box promising "Leads see
  // all languages" beside an "Add as lead — every lane" link. Both claims died
  // with AQU-1813 (a lead sees only the lanes they are granted), and the link
  // never granted every lane. The lane control must stay lane-scoped: no lead
  // note, no lead button, and no path from here to a project_lead membership.
  it("offers no lead path once a person is picked (AQU-2004)", async () => {
    renderPopover()
    openPopover()
    pickMaria()

    const popover = screen.getByTestId("staff-lane-popover")
    expect(popover).not.toHaveTextContent(/broader access|see all languages/i)
    expect(screen.queryByRole("button", { name: /as lead/i })).not.toBeInTheDocument()
    // The lane-scoped add is the only submit left, and it still works.
    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))
    await waitFor(() => expect(mockAddProjectMember).toHaveBeenCalledTimes(1))
    expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "maria", 300, {
      scopeLanes: ["es"],
    })
  })

  // Same guard one layer down: a translated note or lead link would reappear
  // in a non-English UI if any catalog still carried the retired keys.
  it("carries no lead-note or lead-button message in any locale (AQU-2004)", () => {
    const retired = [
      "org.staffLanePopover.broaderAccessNote",
      "org.staffLanePopover.addAsLeadButton",
      "org.grantScope.action.addAsLead",
    ]
    const survivors = Object.entries(CATALOGS).flatMap(([locale, catalog]) =>
      retired.filter((key) => key in catalog).map((key) => `${locale}: ${key}`),
    )
    expect(survivors).toEqual([])
  })

  // AQU-2027: the route's refusal text is the shared constant, so this is the
  // exact string the server sends — the old test faked a wording the route had
  // stopped sending, which is how the raw error reached operators unnoticed.
  it("shows the 'already sees every language' note when the server refuses a maintainer+", async () => {
    mockPutMemberScopes.mockRejectedValue(new Error(LANE_SCOPE_ABOVE_CEILING_ERROR))

    renderPopover()
    openPopover()
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

    await waitFor(() =>
      expect(screen.getByTestId("grant-scope-result")).toHaveTextContent(
        /maria is a maintainer or above on this project, so they already see every language/i,
      ),
    )
    // Not treated as an error state.
    expect(screen.queryByText(LANE_SCOPE_ABOVE_CEILING_ERROR)).not.toBeInTheDocument()
  })

  it("offers no Add for someone the roster shows at maintainer or above", async () => {
    mockProjectMembers = [
      {
        userId: 10,
        username: "maria",
        role: { level: 700, name: "owner", source: "override" },
        secondarySources: [],
      },
    ]

    renderPopover()
    openPopover()
    pickMaria()

    expect(screen.getByTestId("staff-lane-sees-every-lane")).toHaveTextContent(
      /maria is a maintainer or above on this project, so they already see every language/i,
    )
    const add = screen.getByRole("button", { name: /spanish lane only/i })
    expect(add).toBeDisabled()
    fireEvent.click(add)
    expect(mockAddProjectMember).not.toHaveBeenCalled()
    expect(mockPutMemberScopes).not.toHaveBeenCalled()
  })

  it("names the role an existing project lead keeps, not the picked one", async () => {
    mockProjectMembers = [
      {
        userId: 10,
        username: "maria",
        role: { level: 500, name: "project_lead", source: "override" },
        secondarySources: [],
      },
    ]

    renderPopover()
    openPopover()
    pickMaria()

    const preview = /maria stays a project lead on mark, spanish lane only/i
    expect(screen.getByTestId("staff-lane-popover")).toHaveTextContent(preview)
    expect(screen.getByTestId("staff-lane-popover")).not.toHaveTextContent(/will join as a reviewer/i)

    fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

    await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
    // Never a downgrade: no membership write for someone already above the pick.
    expect(mockAddProjectMember).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId("grant-scope-result")).toHaveTextContent(preview))
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
      expect(mockAddProjectMember).toHaveBeenCalledWith("jwt-pm", "proj-1", "kean", 300, {
        scopeLanes: ["es"],
      })
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

  // AQU-1998 — the undo half of the control. Staffing someone onto a lane was
  // one gesture; taking them off meant the org Members → Matrix tab, which is
  // nowhere near the lane and has a trap of its own (unticking the last chip
  // widens the person to every lane). Both halves now live in this popover.
  describe("removing a person from the lane (AQU-1998)", () => {
    const LEAD = { level: 500, name: "project_lead", source: "override" as const }
    const CONTRIB = { level: 400, name: "contributor", source: "override" as const }

    /** Scope rows keyed by user id, for the per-member reads the list makes. */
    function scopesByUser(map: Record<number, Scope[]>) {
      mockFetchMemberScopes.mockImplementation(async (_jwt, _projectId, userId) =>
        map[userId as number] ?? [],
      )
    }

    const MAINTAINER = { level: 600, name: "maintainer", source: "override" as const }

    function staffRoster() {
      mockProjectMembers = [
        { userId: 10, username: "maria", role: CONTRIB, secondarySources: [] },
        { userId: 11, username: "mark", role: CONTRIB, secondarySources: [] },
        { userId: 12, username: "wendi", role: LEAD, secondarySources: [] },
        { userId: 13, username: "jade", role: MAINTAINER, secondarySources: [] },
      ]
    }

    it("lists only the people scoped to this lane, and never a maintainer", async () => {
      staffRoster()
      scopesByUser({
        10: [{ kind: "lane", value: "es" }, { kind: "lane", value: "fr" }],
        11: [{ kind: "lane", value: "fr" }],
        12: [],
      })

      renderPopover()
      openPopover()

      await waitFor(() => expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument())
      // mark is on French only, wendi leads with no lane limit — neither is on this lane.
      expect(screen.queryByTestId("staff-lane-staffed-row-11")).not.toBeInTheDocument()
      expect(screen.queryByTestId("staff-lane-staffed-row-12")).not.toBeInTheDocument()
      // A maintainer is never even asked about: they cannot hold a lane scope.
      expect(mockFetchMemberScopes).not.toHaveBeenCalledWith("jwt-pm", "proj-1", 13)
    })

    // AQU-2027: since AQU-1813 a project lead can be limited to lanes. One who
    // is limited to this lane was invisible here, so nobody could take them off it.
    it("lists a project lead limited to this lane, and Remove takes only this lane off", async () => {
      staffRoster()
      scopesByUser({
        12: [{ kind: "lane", value: "es" }, { kind: "lane", value: "fr" }],
      })

      renderPopover()
      openPopover()

      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-12")).toBeEnabled())
      fireEvent.click(screen.getByTestId("staff-lane-remove-12"))

      await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
      expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 12, [
        { kind: "lane", value: "fr" },
      ])
      await waitFor(() =>
        expect(screen.queryByTestId("staff-lane-staffed-row-12")).not.toBeInTheDocument(),
      )
    })

    it("says so when nobody is staffed on the lane yet", async () => {
      staffRoster()
      scopesByUser({ 10: [{ kind: "lane", value: "fr" }], 11: [] })

      renderPopover()
      openPopover()

      await waitFor(() =>
        expect(screen.getByTestId("staff-lane-staffed-empty")).toBeInTheDocument(),
      )
    })

    it("Remove takes only this lane off, leaving other lanes and file limits intact", async () => {
      staffRoster()
      scopesByUser({
        10: [
          { kind: "lane", value: "es" },
          { kind: "lane", value: "fr" },
          { kind: "file", value: "GEN" },
        ],
        11: [],
      })

      renderPopover()
      openPopover()
      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled())
      fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

      await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
      expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 10, [
        { kind: "lane", value: "fr" },
        { kind: "file", value: "GEN" },
      ])
      // The row goes once the save lands, with no reload.
      await waitFor(() =>
        expect(screen.queryByTestId("staff-lane-staffed-row-10")).not.toBeInTheDocument(),
      )
      expect(mockRefreshProjectMembers).toHaveBeenCalled()
    })

    // AQU-1607: a scope row written before lane ids holds the language tag, so
    // a lane staffed under the old spelling must still be removable by a
    // caller that knows the lane's id.
    it("removes a legacy tag row for this lane when the caller passes a lane id", async () => {
      staffRoster()
      scopesByUser({
        10: [{ kind: "lane", value: "es" }, { kind: "lane", value: "ln-fr" }],
        11: [],
      })

      renderPopover(1, "ln-es")
      openPopover()
      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled())
      fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

      await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
      expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 10, [
        { kind: "lane", value: "ln-fr" },
      ])
    })

    // The trap the members matrix still falls into: an empty lane list means
    // EVERY lane, so removing someone's only lane grants access instead of
    // revoking it. Nothing is saved, and the note names where to go instead.
    it("refuses the person's last lane, pointing at Project Settings → Team members", async () => {
      staffRoster()
      scopesByUser({ 10: [{ kind: "lane", value: "es" }], 11: [] })

      renderPopover()
      openPopover()

      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeDisabled())
      const note = screen.getByTestId("staff-lane-last-lane-note-10")
      expect(note).toHaveTextContent(/only language/i)
      expect(within(note).getByRole("link", { name: /team members/i })).toHaveAttribute(
        "href",
        "/project/proj-1/settings/members",
      )
      fireEvent.click(screen.getByTestId("staff-lane-remove-10"))
      expect(mockPutMemberScopes).not.toHaveBeenCalled()
    })

    // A replace-set PUT built from the rows loaded when the popover opened
    // would silently restore a lane or file limit changed since, so the
    // member's scopes are re-read at the moment of the removal.
    it("re-reads the member's scopes before the PUT instead of trusting the open-time read", async () => {
      staffRoster()
      scopesByUser({
        10: [{ kind: "lane", value: "es" }, { kind: "lane", value: "fr" }],
        11: [],
      })

      renderPopover()
      openPopover()
      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled())

      // Someone granted maria a third lane while the popover sat open.
      scopesByUser({
        10: [
          { kind: "lane", value: "es" },
          { kind: "lane", value: "fr" },
          { kind: "lane", value: "sw" },
        ],
      })
      fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

      await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
      expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 10, [
        { kind: "lane", value: "fr" },
        { kind: "lane", value: "sw" },
      ])
    })

    it("refuses the removal when the re-read shows this is now their only lane", async () => {
      staffRoster()
      scopesByUser({
        10: [{ kind: "lane", value: "es" }, { kind: "lane", value: "fr" }],
        11: [],
      })

      renderPopover()
      openPopover()
      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled())

      // French was taken off her elsewhere; this lane is now the only one.
      scopesByUser({ 10: [{ kind: "lane", value: "es" }] })
      fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

      await waitFor(() =>
        expect(screen.getByTestId("staff-lane-remove-error-10")).toHaveTextContent(
          /nothing was saved/i,
        ),
      )
      expect(mockPutMemberScopes).not.toHaveBeenCalled()
      expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument()
      // And the guard now holds the button, so a second press can't retry it.
      expect(screen.getByTestId("staff-lane-remove-10")).toBeDisabled()
    })

    it("a failed save shows the error and leaves the person listed", async () => {
      staffRoster()
      scopesByUser({
        10: [{ kind: "lane", value: "es" }, { kind: "lane", value: "fr" }],
        11: [],
      })
      mockPutMemberScopes.mockRejectedValue(new Error("Failed to fetch"))

      renderPopover()
      openPopover()
      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled())
      fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

      await waitFor(() =>
        expect(screen.getByTestId("staff-lane-remove-error-10")).toHaveTextContent(
          /failed to fetch/i,
        ),
      )
      // Nothing half-applied: she is still on the lane and still removable.
      expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument()
      expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled()
    })

    // AQU-1999 — the two cases AQU-1998 left open, as decided: the last lane
    // stays blocked (above), and open assignments in the lane close WITH the
    // removal, after a confirmation that names them. An assignment left open
    // in a lane its holder can no longer reach is work nobody is told about;
    // closing it silently is the other way to get that wrong.
    describe("open assignments in the lane (AQU-1999)", () => {
      const OPEN_FR: LaneAssignment[] = [
        { assignmentId: "as-1", fileId: "file-1", scopeLabel: "Mark 1" },
        { assignmentId: "as-2", fileId: "file-2", scopeLabel: "Mark 2" },
      ]

      async function openWithMaria(laneId?: string) {
        staffRoster()
        scopesByUser({
          10: [{ kind: "lane", value: laneId ?? "es" }, { kind: "lane", value: "fr" }],
          11: [],
        })
        renderPopover(1, laneId)
        openPopover()
        await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled())
      }

      it("removes in one press when the person holds nothing open in the lane", async () => {
        await openWithMaria()
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

        await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
        expect(mockFetchMemberLaneAssignments).toHaveBeenCalledWith("jwt-pm", "proj-1", 10, "es")
        // No question asked, and nothing closed — there was nothing to close.
        expect(screen.queryByTestId("staff-lane-remove-confirm-10")).not.toBeInTheDocument()
        expect(mockUnassignAssignment).not.toHaveBeenCalled()
      })

      it("asks first when there is open work, naming the count, and saves nothing yet", async () => {
        mockFetchMemberLaneAssignments.mockResolvedValue(OPEN_FR)
        await openWithMaria()
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

        const confirm = await screen.findByTestId("staff-lane-remove-confirm-10")
        expect(confirm).toHaveTextContent(/2 open assignments in spanish/i)
        expect(confirm).toHaveTextContent(/already finished stays as it is/i)
        // Nothing is saved by the question itself.
        expect(mockUnassignAssignment).not.toHaveBeenCalled()
        expect(mockPutMemberScopes).not.toHaveBeenCalled()
        expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument()
      })

      it("the confirm closes every open assignment, then takes the lane off", async () => {
        mockFetchMemberLaneAssignments.mockResolvedValue(OPEN_FR)
        await openWithMaria()
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))
        fireEvent.click(await screen.findByTestId("staff-lane-remove-confirm-button-10"))

        await waitFor(() => expect(mockUnassignAssignment).toHaveBeenCalledTimes(2))
        expect(mockUnassignAssignment).toHaveBeenCalledWith({
          jwt: "jwt-pm",
          projectId: "proj-1",
          fileId: "file-1",
          author: "pm",
          assignmentId: "as-1",
        })
        expect(mockUnassignAssignment).toHaveBeenCalledWith({
          jwt: "jwt-pm",
          projectId: "proj-1",
          fileId: "file-2",
          author: "pm",
          assignmentId: "as-2",
        })
        await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
        expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 10, [
          { kind: "lane", value: "fr" },
        ])
        await waitFor(() =>
          expect(screen.queryByTestId("staff-lane-staffed-row-10")).not.toBeInTheDocument(),
        )
      })

      it("Cancel leaves both the lane and the work as they were", async () => {
        mockFetchMemberLaneAssignments.mockResolvedValue(OPEN_FR)
        await openWithMaria()
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))
        fireEvent.click(await screen.findByTestId("staff-lane-remove-cancel-10"))

        expect(screen.queryByTestId("staff-lane-remove-confirm-10")).not.toBeInTheDocument()
        expect(mockUnassignAssignment).not.toHaveBeenCalled()
        expect(mockPutMemberScopes).not.toHaveBeenCalled()
        // And the removal can be started again.
        expect(screen.getByTestId("staff-lane-remove-10")).toBeEnabled()
      })

      // "Couldn't tell" is not "nothing open": reading it as zero is exactly
      // how an assignment ends up stranded in a lane nobody can open.
      it("refuses the removal when the open-assignment read fails", async () => {
        mockFetchMemberLaneAssignments.mockResolvedValue(null)
        await openWithMaria()
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

        await waitFor(() =>
          expect(screen.getByTestId("staff-lane-remove-error-10")).toHaveTextContent(
            /nothing was removed/i,
          ),
        )
        expect(mockUnassignAssignment).not.toHaveBeenCalled()
        expect(mockPutMemberScopes).not.toHaveBeenCalled()
        expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument()
      })

      // The last-lane guard is re-checked before anything closes, so a
      // refused removal never leaves closed assignments behind it.
      it("closes nothing when the re-read shows this is now their only lane", async () => {
        mockFetchMemberLaneAssignments.mockResolvedValue(OPEN_FR)
        await openWithMaria()
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))
        await screen.findByTestId("staff-lane-remove-confirm-10")

        // French was taken off her elsewhere while the question sat open.
        scopesByUser({ 10: [{ kind: "lane", value: "es" }] })
        fireEvent.click(screen.getByTestId("staff-lane-remove-confirm-button-10"))

        await waitFor(() =>
          expect(screen.getByTestId("staff-lane-remove-error-10")).toHaveTextContent(
            /nothing was saved/i,
          ),
        )
        expect(mockUnassignAssignment).not.toHaveBeenCalled()
        expect(mockPutMemberScopes).not.toHaveBeenCalled()
      })

      // The closes land before the scope PUT, so a failure here leaves the
      // person holding the lane whatever is still assigned to them sits in.
      it("a failed close leaves the person on the lane and saves no scopes", async () => {
        mockFetchMemberLaneAssignments.mockResolvedValue(OPEN_FR)
        mockUnassignAssignment.mockRejectedValue(new Error("Request failed (HTTP 403)"))
        await openWithMaria()
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))
        fireEvent.click(await screen.findByTestId("staff-lane-remove-confirm-button-10"))

        await waitFor(() =>
          expect(screen.getByTestId("staff-lane-remove-error-10")).toHaveTextContent(/403/),
        )
        expect(mockPutMemberScopes).not.toHaveBeenCalled()
        expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument()
      })

      // AQU-1607: the lane a removal counts work in is the one the caller
      // names, by id where it has one — never a sibling lane's tag.
      it("counts the open work by lane id when the caller passes one", async () => {
        await openWithMaria("ln-es")
        fireEvent.click(screen.getByTestId("staff-lane-remove-10"))

        await waitFor(() =>
          expect(mockFetchMemberLaneAssignments).toHaveBeenCalledWith(
            "jwt-pm",
            "proj-1",
            10,
            "ln-es",
          ),
        )
      })
    })

    it("the add half still works alongside the list", async () => {
      staffRoster()
      scopesByUser({ 10: [{ kind: "lane", value: "es" }], 11: [] })

      renderPopover()
      openPopover()
      await waitFor(() => expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument())

      fireEvent.click(screen.getByText("mark"))
      fireEvent.click(screen.getByRole("button", { name: /spanish lane only/i }))

      await waitFor(() => expect(mockPutMemberScopes).toHaveBeenCalledTimes(1))
      expect(mockPutMemberScopes).toHaveBeenCalledWith("jwt-pm", "proj-1", 11, [
        { kind: "lane", value: "es" },
      ])
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
