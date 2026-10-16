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
//   - Graceful handling of the server's "leads unscopable" 400: if the scope
//     PUT is rejected because the target's effective role is already lead+,
//     the popover reports success ("already leads … no lane scope needed"),
//     not an error.
//   - AQU-1998 Remove: the popover lists who is already scoped to the lane and
//     takes one of them off it — their other lanes and file limits written
//     through untouched, leads never listed, and the person's LAST lane
//     guarded (an empty lane list means every lane, so that removal would
//     widen their access).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable } from "@/components/ui/data-table"
import { StaffLanePopover } from "./StaffLanePopover"
import { CATALOGS } from "@/lib/i18n/messages"

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

    function staffRoster() {
      mockProjectMembers = [
        { userId: 10, username: "maria", role: CONTRIB, secondarySources: [] },
        { userId: 11, username: "mark", role: CONTRIB, secondarySources: [] },
        { userId: 12, username: "wendi", role: LEAD, secondarySources: [] },
      ]
    }

    it("lists only the people scoped to this lane, and never a lead", async () => {
      staffRoster()
      scopesByUser({
        10: [{ kind: "lane", value: "es" }, { kind: "lane", value: "fr" }],
        11: [{ kind: "lane", value: "fr" }],
        12: [],
      })

      renderPopover()
      openPopover()

      await waitFor(() => expect(screen.getByTestId("staff-lane-staffed-row-10")).toBeInTheDocument())
      // mark is on French only, wendi leads the project — neither is on this lane.
      expect(screen.queryByTestId("staff-lane-staffed-row-11")).not.toBeInTheDocument()
      expect(screen.queryByTestId("staff-lane-staffed-row-12")).not.toBeInTheDocument()
      // A lead is never even asked about: they cannot hold a lane scope.
      expect(mockFetchMemberScopes).not.toHaveBeenCalledWith("jwt-pm", "proj-1", 12)
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
