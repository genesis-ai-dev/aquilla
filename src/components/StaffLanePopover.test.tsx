// AQU-538 §3.4 — StaffLanePopover: the one-gesture staffing control.
//
// Pins under test:
//   - AQU-2322: the Add writes nothing itself. It opens Give access
//     pre-filled with the person, the picked role and this lane (by id), so
//     the grant goes through that dialog's dry run and the additive
//     lane-grant route, never membership POST + scope PUT from here.
//   - AQU-2004: there is no lead path here at all — no "Leads see all
//     languages" note, no "Add as lead" button, and no catalog in any locale
//     still carrying those retired messages.
//   - AQU-2027: maintainers and above can't be lane-limited. Someone the
//     roster shows at 600+ gets a note and no Add. Someone already on the
//     project at or above the picked role keeps their role, and the sentence
//     says so ("stays a Project Lead").
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
import { OverviewLaneTable } from "@/components/org/OverviewLaneTable"
import { CATALOGS } from "@/lib/i18n/messages/all"

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
  // The real Languages table (rendered once below) reads the scope view.
  fetchMemberScopeView: async (jwt: string, projectId: string, userId: number) => ({
    scopes: (await mockFetchMemberScopes(jwt, projectId, userId)) ?? [],
    laneNames: {},
  }),
  putMemberScopes: mockPutMemberScopes,
  fetchMemberLaneAssignments: mockFetchMemberLaneAssignments,
}))

// AQU-2322: the Add opens Give access; the stub shows what it was pre-filled with.
vi.mock("@/components/org/access/GiveAccessLauncher", () => ({
  GiveAccessLauncher: ({ orgId, request }: { orgId: number; request: { userId?: string; roleLevel?: number; place?: { type: string; id: string } } | null }) =>
    request ? (
      <div
        data-testid="give-access-launch"
        data-org={orgId}
        data-user={request.userId}
        data-role={request.roleLevel}
        data-place={request.place ? `${request.place.type}:${request.place.id}` : ""}
      />
    ) : null,
}))

vi.mock("@/lib/sync/assignments", () => ({
  unassignAssignment: mockUnassignAssignment,
}))

// The Languages table mounts one Assign dialog; it has its own suite.
vi.mock("@/components/AssignModal", () => ({ AssignModal: () => null }))

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
  it("hands the Add to Give access pre-filled with the person, role and lane, and writes nothing itself (AQU-2322)", async () => {
    renderPopover(1, "ln-es")
    openPopover()
    expect(screen.getByTestId("staff-lane-scope-title")).toHaveTextContent("Add people to Mark › Spanish")
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /spanish language lane only/i }))

    const launch = await screen.findByTestId("give-access-launch")
    expect(launch).toHaveAttribute("data-org", "1")
    expect(launch).toHaveAttribute("data-user", "10")
    expect(launch).toHaveAttribute("data-role", "300")
    expect(launch).toHaveAttribute("data-place", "lane:ln-es")
    // The old write path is gone: no membership POST, no scope replace-set.
    expect(mockAddProjectMember).not.toHaveBeenCalled()
    expect(mockPutMemberScopes).not.toHaveBeenCalled()
    // The popover steps aside so the dialog is on top.
    await waitFor(() => expect(screen.queryByTestId("staff-lane-popover")).not.toBeInTheDocument())
  })

  it("a lane the row knows only by its tag opens Give access with the place left to choose", async () => {
    renderPopover(1)
    openPopover()
    pickMaria()
    fireEvent.click(screen.getByRole("button", { name: /spanish language lane only/i }))
    expect(await screen.findByTestId("give-access-launch")).toHaveAttribute("data-place", "")
    expect(mockPutMemberScopes).not.toHaveBeenCalled()
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
    // The lane-scoped add is the only submit left; it opens Give access at a lane role (AQU-2322).
    fireEvent.click(screen.getByRole("button", { name: /spanish language lane only/i }))
    expect(await screen.findByTestId("give-access-launch")).toHaveAttribute("data-role", "300")
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
    const add = screen.getByRole("button", { name: /spanish language lane only/i })
    expect(add).toBeDisabled()
    fireEvent.click(add)
    expect(screen.queryByTestId("give-access-launch")).not.toBeInTheDocument()
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

    const preview = /maria remains project lead on mark, spanish language lane only/i
    expect(screen.getByTestId("staff-lane-popover")).toHaveTextContent(preview)
    expect(screen.getByTestId("staff-lane-popover")).not.toHaveTextContent(/will join as reviewer/i)
  })

  it("filters the org roster by the search query", async () => {
    renderPopover()
    openPopover()
    fireEvent.change(screen.getByPlaceholderText(/search org members and project invitees/i), {
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

  // AQU-2048: since AQU-1798 the pool is org members plus people already on
  // the project. The popover must name both, and still send someone who is
  // neither through the project invite.
  it("says the search covers org members and people already invited to the project", () => {
    renderPopover()
    openPopover()

    const popover = screen.getByTestId("staff-lane-popover")
    expect(popover).toHaveTextContent(
      /add an org member or someone already invited to this project, scoped to this language lane/i,
    )
    expect(popover).toHaveTextContent(
      /searches org members and people already invited to this project\. adding someone who is neither\?/i,
    )
    expect(screen.getByRole("link", { name: /invite them to the project/i })).toBeInTheDocument()
    expect(popover).not.toHaveTextContent(/searches your organization only/i)
    expect(popover).not.toHaveTextContent(/search your organization/i)

    fireEvent.change(screen.getByPlaceholderText(/search org members and project invitees/i), {
      target: { value: "nobody-here" },
    })
    expect(screen.getByText(/no org members or project invitees match/i)).toBeInTheDocument()
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
      // The org list is hidden, but Kean is already on the project and listed.
      // The note must not tell the operator that an invite is the only way.
      expect(screen.getByTestId("staff-lane-roster-note")).toHaveTextContent(
        /people already on this project are listed below/i,
      )
      expect(screen.getByTestId("staff-lane-roster-note")).not.toHaveTextContent(/instead/i)
      fireEvent.click(screen.getByText("kean"))
      fireEvent.click(screen.getByRole("button", { name: /spanish language lane only/i }))

      // AQU-2322: the project invitee is handed to Give access, which writes the lane grant.
      expect(await screen.findByTestId("give-access-launch")).toHaveAttribute("data-user", "22")
      expect(mockAddProjectMember).not.toHaveBeenCalled()
      expect(mockPutMemberScopes).not.toHaveBeenCalled()
    })

    it("tells a non-org-member project admin that they can't see the roster", () => {
      mockRoster = { members: [], rosterAccessDenied: true }
      renderPopover()
      openPopover()

      expect(blockedRow()).toHaveAttribute("data-reason", "no-access")
      expect(screen.getByText(/can’t see this organization’s member list/i)).toBeInTheDocument()
      expect(screen.queryByText(/no one in your organization yet/i)).not.toBeInTheDocument()
    })

    it("still lists a direct invite when the operator can't see the org roster", () => {
      mockRoster = { members: [], rosterAccessDenied: true }
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
      expect(screen.getByTestId("staff-lane-roster-note")).toHaveTextContent(
        /can’t see this organization’s member list\. people already on this project are listed below/i,
      )
      expect(screen.getByTestId("staff-lane-roster-note")).not.toHaveTextContent(/instead/i)
      expect(screen.getByText("kean")).toBeInTheDocument()
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
      expect(screen.getByPlaceholderText(/search org members and project invitees/i)).toBeDisabled()
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
    it("refuses the person's last lane, pointing at Project settings → Members", async () => {
      staffRoster()
      scopesByUser({ 10: [{ kind: "lane", value: "es" }], 11: [] })

      renderPopover()
      openPopover()

      await waitFor(() => expect(screen.getByTestId("staff-lane-remove-10")).toBeDisabled())
      const note = screen.getByTestId("staff-lane-last-lane-note-10")
      expect(note).toHaveTextContent(/only language/i)
      expect(within(note).getByRole("link", { name: /project settings → members/i })).toHaveAttribute(
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
      fireEvent.click(screen.getByRole("button", { name: /spanish language lane only/i }))

      expect(await screen.findByTestId("give-access-launch")).toHaveAttribute("data-user", "11")
      expect(mockPutMemberScopes).not.toHaveBeenCalled()
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

      fireEvent.change(screen.getByPlaceholderText(/search org members and project invitees/i), {
        target: { value: "mari" },
      })
      expect(onRowClick).not.toHaveBeenCalled()

      // Picking a name advances to the role step instead of navigating away.
      pickMaria()
      expect(onRowClick).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: /spanish language lane only/i })).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: /spanish language lane only/i }))
      expect(await screen.findByTestId("give-access-launch")).toBeInTheDocument()
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

  // AQU-2322: the walk of PR 2180 clicked Add and got no dialog. The table's
  // columns depend on which lane's popover is open, so closing the popover
  // rebuilds the actions cell and remounts it; a request held in the popover
  // was gone before the launcher could read it. The real table, not a stand-in.
  it("in the project's Languages table, Add opens Give access though the table remounts the popover as it closes (AQU-2322)", async () => {
    render(
      <MemoryRouter>
        <OverviewLaneTable
          projectId="proj-1"
          projectName="Mark"
          orgId={1}
          jwt="jwt-pm"
          lanes={[{ lane: "es", laneId: "ln-es", name: "Spanish", role: "target", totalCells: 10, filledCells: 0, validatedCells: 0, lastEditAt: null }]}
          defaultLanguageLabel="English"
          extraLanes={[]}
          files={[]}
          roleLevel={700}
          author="pm"
          canManageLanes
          canAddLanguage={false}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId("overview-lane-people-es"))
    pickMaria()
    fireEvent.click(await screen.findByRole("button", { name: /spanish language lane only/i }))

    const launch = await screen.findByTestId("give-access-launch")
    expect(launch).toHaveAttribute("data-user", "10")
    expect(launch).toHaveAttribute("data-place", "lane:ln-es")
    await waitFor(() => expect(screen.queryByTestId("staff-lane-popover")).not.toBeInTheDocument())
  })
})
