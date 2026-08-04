// AQU-180: Unit tests for ProjectMembersPage surface.
//
// Why these tests exist:
//   - Route is reachable at /project/:id/members without crashing
//   - Members list renders correctly for different grant sources
//   - "Revoke all" button shows the typed-confirmation dialog
//   - Confirmation gating: button is disabled until username typed
//   - Invite-link tab shows the form and renders the invite URL after creation

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectMembersPage } from "./ProjectMembersPage"
import { partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import type { OrgMember } from "@/lib/frontier/orgs"

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockMembers = [
  {
    userId: 1,
    username: "alice",
    role: { level: 600, name: "maintainer", source: "override" as const },
    secondarySources: [],
  },
  {
    userId: 2,
    username: "bob",
    role: { level: 400, name: "contributor", source: "org" as const },
    secondarySources: [],
  },
  {
    userId: 3,
    username: "carol",
    role: { level: 500, name: "project_lead", source: "override" as const },
    secondarySources: [
      { source: "org" as const, level: 100, name: "viewer" },
    ],
  },
  {
    userId: 4,
    username: "erin",
    role: { level: 400, name: "contributor", source: "group" as const },
    secondarySources: [],
  },
]

const mockRefresh = vi.fn().mockResolvedValue(undefined)
const mockAdd = vi.fn().mockResolvedValue(mockMembers[0])
const mockAddMany = vi.fn(
  async (
    toAdd: Array<{ username: string; role: number }>,
  ): Promise<Array<{ username: string; ok: boolean; error?: { code: string; message: string } }>> =>
    toAdd.map(({ username }) => ({ username, ok: true })),
)
const mockRemove = vi.fn().mockResolvedValue(undefined)

const mockUseProjectMembers = vi.fn(() => ({
  members: mockMembers,
  isLoading: false,
  error: null,
  rosterHidden: false,
  refresh: mockRefresh,
  add: mockAdd,
  addMany: mockAddMany,
  remove: mockRemove,
  changeRole: mockAdd,
}))

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => mockUseProjectMembers(),
}))

// AQU-734 parity: the add row's typeahead calls the user-search hook; keep it
// deterministic and offline (no fetch) — suggestion rows come from the mocked
// org roster below, so an empty search result set is the interesting case.
vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: (query: string) => ({
    query,
    results: [],
    isLoading: false,
    needsMorePrefix: query.trim().length < 2,
    lastFetchOk: true,
  }),
}))

// Org context + roster driving the eligible-colleague suggestions. Hoisted so
// the mock factories (which run before module bodies) can reference it; each
// suite resets the values it cares about.
const orgMocks = vi.hoisted(() => ({
  activeOrgId: null as number | null,
  roster: [] as Array<{ userId: number; username: string; role: { level: number; name: string } }>,
}))

vi.mock("@/context/OrgContext", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/context/OrgContext")>()
  return {
    ...original,
    useActiveOrgOptional: () =>
      orgMocks.activeOrgId == null ? null : { activeOrgId: orgMocks.activeOrgId },
  }
})

vi.mock("@/lib/frontier/orgs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/frontier/orgs")>()
  return {
    ...original,
    listOrgMembers: vi.fn(async () => orgMocks.roster),
  }
})

// useProjectOrgId resolves the project's own org; keep it offline here and
// let the suites drive suggestions through the active-org fallback.
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return {
    ...original,
    resolveCloudProjectResult: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
  }
})

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "test-jwt", username: "alice" },
  }),
}))

vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/frontier/members")>()
  return {
    ...original,
    revokeAllProjectAccess: vi.fn().mockResolvedValue({
      removed: true,
      grantPaths: [
        { source: "override", level: 600, name: "maintainer", removable: true },
      ],
    }),
  }
})

vi.mock("@/lib/sync/invites", () => ({
  createServerInvite: vi.fn().mockResolvedValue({
    token: "test-token-abc123",
    projectId: "proj-1",
    role: 400,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
  }),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────

function renderPage(projectId = "proj-1") {
  return render(
    <MemoryRouter initialEntries={[`/project/${projectId}/members`]}>
      <Routes>
        <Route path="/project/:id/members" element={<ProjectMembersPage />} />
        <Route path="/project/:id/editor" element={<div>Editor</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ProjectMembersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows explicit progress while the member list is unresolved", () => {
    mockUseProjectMembers.mockReturnValueOnce({
      members: [],
      isLoading: true,
      error: null,
      rosterHidden: false,
      refresh: mockRefresh,
      add: mockAdd,
      addMany: mockAddMany,
      remove: mockRemove,
      changeRole: mockAdd,
    })

    renderPage()

    const status = screen.getByRole("status", { name: "Loading members" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
    expect(screen.queryByText("No members yet.")).not.toBeInTheDocument()
  })

  it("renders the page header and tab bar", () => {
    renderPage()
    expect(screen.getByText("Back to project")).toBeInTheDocument()
    // "Members" appears twice: header div + tab button — verify both exist
    const allMembers = screen.getAllByText("Members")
    expect(allMembers.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Invite link")).toBeInTheDocument()
  })

  it("renders the current members list", () => {
    renderPage()
    expect(screen.getByText("alice")).toBeInTheDocument()
    expect(screen.getByText("bob")).toBeInTheDocument()
    expect(screen.getByText("carol")).toBeInTheDocument()
  })

  it("shows org badge for org-sourced members", () => {
    renderPage()
    // bob is via org, carol has a secondary org source
    const orgBadges = screen.getAllByText("via org")
    expect(orgBadges.length).toBeGreaterThanOrEqual(1)
  })

  // AQU-488: a first-time PM must be able to tell this list is scoped to
  // THIS project (not the whole org) without asking anyone.
  it("labels the members list with an explicit project scope", () => {
    renderPage()
    // With org-sourced members present, the roster is partitioned (AQU-454):
    // the direct roster is headed "Project members" and the scope copy spells
    // out that the list covers access to THIS project.
    expect(screen.getByText("Project members")).toBeInTheDocument()
    expect(
      screen.getByText(/everyone who currently has access to this project/i),
    ).toBeInTheDocument()
  })

  // AQU-488: every row must indicate how that person has access — direct
  // project invite, org membership, or team — not just org-sourced ones.
  it("labels each row with its access path (direct invite / org / team)", () => {
    renderPage()
    // alice + carol are direct (override) grants
    expect(screen.getAllByText("direct invite").length).toBeGreaterThanOrEqual(2)
    // bob is org-sourced
    expect(screen.getAllByText("via org").length).toBeGreaterThanOrEqual(1)
    // erin has access via a team (group) grant
    expect(screen.getByText("via team")).toBeInTheDocument()
  })

  it("shows secondary sources for members with multiple paths", () => {
    renderPage()
    // carol has a secondary org:viewer source
    expect(screen.getByText(/org:viewer/)).toBeInTheDocument()
  })

  it("shows 'Revoke all' button for members the caller can manage", () => {
    renderPage()
    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    // alice (self), bob, carol — but alice is the logged-in user and is
    // skipped for self. That check is null in mock (callerUserId=null),
    // so all members get the button in tests.
    expect(revokeButtons.length).toBeGreaterThan(0)
  })

  it("opens the revoke-all dialog when Revoke all is clicked", async () => {
    renderPage()
    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    fireEvent.click(revokeButtons[0])
    await waitFor(() => {
      expect(screen.getByText("Revoke all access")).toBeInTheDocument()
    })
  })

  it("disables the confirm button until the username is typed", async () => {
    renderPage()
    // Open dialog for alice
    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    fireEvent.click(revokeButtons[0]) // opens dialog for alice

    await waitFor(() => {
      expect(screen.getByText("Revoke all access")).toBeInTheDocument()
    })

    const confirmBtn = screen.getByRole("button", { name: "Revoke access" })
    expect(confirmBtn).toBeDisabled()

    // Type wrong value — still disabled
    const input = screen.getByPlaceholderText("alice")
    fireEvent.change(input, { target: { value: "wrong" } })
    expect(confirmBtn).toBeDisabled()

    // Type the correct username — enabled
    fireEvent.change(input, { target: { value: "alice" } })
    expect(confirmBtn).not.toBeDisabled()
  })

  it("calls revokeAllProjectAccess and shows result after confirm", async () => {
    const { revokeAllProjectAccess } = await import("@/lib/frontier/members")
    renderPage()

    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    fireEvent.click(revokeButtons[0])

    await waitFor(() => screen.getByText("Revoke all access"))

    const input = screen.getByPlaceholderText("alice")
    fireEvent.change(input, { target: { value: "alice" } })

    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }))

    await waitFor(() => {
      expect(revokeAllProjectAccess).toHaveBeenCalledWith("test-jwt", "proj-1", 1)
    })

    // Result state: "Access revoked" shown
    await waitFor(() => {
      expect(screen.getByText("Access revoked")).toBeInTheDocument()
    })
  })

  it("navigates to invite tab and shows the invite form", async () => {
    renderPage()
    // The invite tab button — there can be multiple "Create invite link" texts
    // (heading + button), so just check the section heading appears.
    const tabs = screen.getAllByRole("button")
    const inviteTab = tabs.find((b) => b.textContent === "Invite link")
    expect(inviteTab).toBeTruthy()
    fireEvent.click(inviteTab!)
    await waitFor(() => {
      // The heading h2 rendered inside the invite form
      expect(screen.getAllByText("Create invite link").length).toBeGreaterThan(0)
    })
  })

  it("creates an invite link and shows the URL", async () => {
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderPage()

    const tabs = screen.getAllByRole("button")
    const inviteTab = tabs.find((b) => b.textContent === "Invite link")!
    fireEvent.click(inviteTab)

    await waitFor(() =>
      expect(screen.getAllByText("Create invite link").length).toBeGreaterThan(0),
    )

    // Click the "Create invite link" button (not the heading)
    const createButtons = screen.getAllByRole("button", { name: "Create invite link" })
    fireEvent.click(createButtons[createButtons.length - 1])

    await waitFor(() => {
      expect(createServerInvite).toHaveBeenCalledWith(
        "test-jwt",
        "proj-1",
        400,        // DEFAULT_INVITE_ROLE
        undefined,
        undefined,  // no email
        7,          // DEFAULT_EXPIRY_DAYS
      )
    })

    await waitFor(() => {
      expect(screen.getByText("Invite link ready")).toBeInTheDocument()
      expect(screen.getByDisplayValue(/\/join\/test-token-abc123/)).toBeInTheDocument()
    })
  })

  it("adds a single typed member via one batch call (AQU-734 parity)", async () => {
    renderPage()

    const input = screen.getByPlaceholderText("Aquilla username")
    fireEvent.change(input, { target: { value: "dave" } })

    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => {
      expect(mockAddMany).toHaveBeenCalledTimes(1)
      expect(mockAddMany).toHaveBeenCalledWith([{ username: "dave", role: 400 }])
    })
  })
})

describe("Remove needs confirmation + no numeric role leaks (FRO-368)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("Remove opens a confirm dialog instead of removing instantly", async () => {
    renderPage()
    // alice + carol have override grants → Remove buttons render
    const removeButtons = screen.getAllByRole("button", { name: /^remove$/i })
    fireEvent.click(removeButtons[0])
    expect(mockRemove).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText("Remove member")).toBeInTheDocument()
    })
    // Dialog copy names the role label, never the numeric level
    expect(screen.getByText(/direct Maintainer access/)).toBeInTheDocument()
    expect(screen.queryByText(/level \d+/i)).not.toBeInTheDocument()
  })

  it("confirming the dialog calls remove for the right member", async () => {
    renderPage()
    fireEvent.click(screen.getAllByRole("button", { name: /^remove$/i })[0])
    const dialog = await screen.findByRole("dialog")
    // House ConfirmActionDialog: tick the understanding checkbox, then confirm.
    // Click the label text (not the control): happy-dom double-toggles a
    // label-wrapped checkbox clicked directly. Scope to the dialog so the
    // rows' own "Remove" buttons aren't matched.
    fireEvent.click(within(dialog).getByText(/I understand this action/i))
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith(1))
  })

  it("revoke-all grant paths show role labels, not numeric levels", async () => {
    renderPage()
    fireEvent.click(screen.getAllByRole("button", { name: /^revoke all$/i })[0])
    await waitFor(() => screen.getByText("Revoke all access"))
    expect(screen.queryByText(/\(level \d+\)/i)).not.toBeInTheDocument()
    expect(screen.getByText("→ Maintainer")).toBeInTheDocument()
  })
})

describe("partitionMembers (AQU-454)", () => {
  const mk = (
    userId: number,
    username: string,
    source: ProjectMember["role"]["source"],
    secondary: ProjectMember["secondarySources"] = [],
  ): ProjectMember => ({
    userId,
    username,
    role: { level: 100, name: "viewer", source },
    secondarySources: secondary,
  })

  it("keeps direct, group, and creator members in the project bucket", () => {
    const { projectMembers, orgAccessMembers } = partitionMembers([
      mk(1, "direct", "override"),
      mk(2, "group", "group"),
      mk(3, "creator", "creator"),
    ])
    expect(projectMembers.map((m) => m.username)).toEqual(["direct", "group", "creator"])
    expect(orgAccessMembers).toHaveLength(0)
  })

  it("routes org-baseline-only members to the org bucket", () => {
    const { projectMembers, orgAccessMembers } = partitionMembers([mk(1, "orgonly", "org")])
    expect(projectMembers).toHaveLength(0)
    expect(orgAccessMembers.map((m) => m.username)).toEqual(["orgonly"])
  })

  it("treats a member with a secondary project path as a project member", () => {
    // Winning path is org (e.g. org owner) but they also hold a direct grant —
    // they belong on the team, not the org-access list.
    const { projectMembers, orgAccessMembers } = partitionMembers([
      mk(1, "ownerplus", "org", [{ source: "override", level: 400, name: "contributor" }]),
    ])
    expect(projectMembers.map((m) => m.username)).toEqual(["ownerplus"])
    expect(orgAccessMembers).toHaveLength(0)
  })

  it("preserves order within each bucket", () => {
    const { projectMembers, orgAccessMembers } = partitionMembers([
      mk(1, "a", "override"),
      mk(2, "b", "org"),
      mk(3, "c", "override"),
      mk(4, "d", "org"),
    ])
    expect(projectMembers.map((m) => m.username)).toEqual(["a", "c"])
    expect(orgAccessMembers.map((m) => m.username)).toEqual(["b", "d"])
  })
})

describe("ProjectMembersPage — AQU-454 roster sectioning", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sections org-baseline members under a distinct heading", () => {
    renderPage()
    // bob (source: org) is the only org-baseline member in the mock roster.
    expect(screen.getByText("Project members")).toBeInTheDocument()
    const orgSection = screen.getByTestId("org-access-members")
    expect(orgSection).toHaveTextContent("Organization members with access")
    expect(orgSection).toHaveTextContent("bob")
    // alice/carol (direct grants) must NOT be inside the org-access section.
    expect(orgSection).not.toHaveTextContent("alice")
    expect(orgSection).not.toHaveTextContent("carol")
  })

  it("omits the org-access section when every member has a project grant", () => {
    mockUseProjectMembers.mockReturnValueOnce({
      members: [mockMembers[0], mockMembers[2]], // alice + carol, both direct
      isLoading: false,
      error: null,
      rosterHidden: false,
      refresh: mockRefresh,
      add: mockAdd,
      addMany: mockAddMany,
      remove: mockRemove,
      changeRole: mockAdd,
    })
    renderPage()
    expect(screen.queryByTestId("org-access-members")).not.toBeInTheDocument()
    expect(screen.getByText("Current members")).toBeInTheDocument()
  })
})

describe("ProjectMembersPage — AQU-485 roster visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The whole point of AQU-485's project-level gate is that a below-floor
  // caller must not see the member list OR the add-member form (which would
  // imply an editable roster exists) — rendering "no members" instead would
  // be a lie (the roster is hidden, not empty).
  it("renders a 'Roster hidden' state instead of the member list when rosterHidden is true", async () => {
    mockUseProjectMembers.mockReturnValueOnce({
      members: [],
      isLoading: false,
      error: null,
      rosterHidden: true,
      refresh: mockRefresh,
      add: mockAdd,
      addMany: mockAddMany,
      remove: mockRemove,
      changeRole: mockAdd,
    })

    renderPage()

    expect(screen.getByText(/roster hidden/i)).toBeInTheDocument()
    expect(screen.queryByText("alice")).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("Aquilla username")).not.toBeInTheDocument()
  })

  it("renders the normal member list when rosterHidden is false (control)", () => {
    renderPage()
    expect(screen.queryByText(/roster hidden/i)).not.toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()
  })
})

// AQU-672: the add-member field is a combobox that suggests org members (minus
// those already directly granted) yet stays free-text for exact usernames.
describe("MembersTab multi-select add — AQU-672 suggestions + AQU-734 batch", () => {
  const om = (userId: number, username: string): OrgMember =>
    ({ userId, username, role: { level: 400, name: "contributor" } }) as OrgMember

  beforeEach(() => {
    vi.clearAllMocks()
    orgMocks.activeOrgId = 7
    // alice(1) holds a direct grant (ineligible); bob(2) is org-access-only
    // and stays eligible for an explicit direct role; dana/dave are new.
    orgMocks.roster = [om(1, "alice"), om(2, "bob"), om(5, "dana"), om(6, "dave")]
  })

  function focusAddInput() {
    const input = screen.getByPlaceholderText("Aquilla username")
    fireEvent.focus(input)
    return input
  }

  it("opens on focus and lists eligible org colleagues as checkbox rows", async () => {
    renderPage()
    focusAddInput()

    // Eligible = org roster minus direct grants: bob (org-access), dana, dave.
    expect(await screen.findByRole("checkbox", { name: "bob" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "dana" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "dave" })).toBeInTheDocument()
    // alice already holds a direct grant — not offered.
    expect(screen.queryByRole("checkbox", { name: "alice" })).not.toBeInTheDocument()
  })

  it("checking people stages removable chips that survive a new search term", async () => {
    renderPage()
    const input = focusAddInput()

    fireEvent.click(await screen.findByRole("checkbox", { name: "dana" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "dave" }))

    const chips = screen.getByRole("list", { name: "People to add" })
    expect(within(chips).getByText("dana")).toBeInTheDocument()
    expect(within(chips).getByText("dave")).toBeInTheDocument()

    // Typing a fresh query must not drop the staged chips.
    fireEvent.change(input, { target: { value: "zz" } })
    expect(within(chips).getByText("dana")).toBeInTheDocument()
    expect(within(chips).getByText("dave")).toBeInTheDocument()

    // Chips are individually removable.
    fireEvent.click(screen.getByRole("button", { name: "Remove dave" }))
    expect(within(chips).queryByText("dave")).not.toBeInTheDocument()
  })

  it("narrows suggestions by substring and keeps checked state", async () => {
    renderPage()
    const input = focusAddInput()

    fireEvent.click(await screen.findByRole("checkbox", { name: "dana" }))
    fireEvent.change(input, { target: { value: "da" } })

    // "da" matches dana + dave only; dana keeps her checked state.
    expect(await screen.findByRole("checkbox", { name: "dana" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(screen.getByRole("checkbox", { name: "dave" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    expect(screen.queryByRole("checkbox", { name: "bob" })).not.toBeInTheDocument()
  })

  it("grants the staged batch in ONE call; a partial failure names only the loser and keeps them staged", async () => {
    mockAddMany.mockResolvedValueOnce([
      { username: "dana", ok: true },
      { username: "dave", ok: true },
      { username: "bogus", ok: false, error: { code: "not_found", message: "No user found" } },
    ])
    renderPage()
    const input = focusAddInput()

    fireEvent.click(await screen.findByRole("checkbox", { name: "dana" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "dave" }))
    // Free-typed name staged as a chip with Enter (AQU-734).
    fireEvent.change(input, { target: { value: "bogus" } })
    fireEvent.keyDown(input, { key: "Enter" })

    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => {
      expect(mockAddMany).toHaveBeenCalledTimes(1)
      expect(mockAddMany).toHaveBeenCalledWith([
        { username: "dana", role: 400 },
        { username: "dave", role: 400 },
        { username: "bogus", role: 400 },
      ])
    })

    // The two successes drop; the failure is named and stays staged for a retry.
    expect(
      await screen.findByText(/couldn't add 1 person: bogus \(No user found\)/i),
    ).toBeInTheDocument()
    const chips = screen.getByRole("list", { name: "People to add" })
    expect(within(chips).getByText("bogus")).toBeInTheDocument()
    expect(within(chips).queryByText("dana")).not.toBeInTheDocument()
    expect(within(chips).queryByText("dave")).not.toBeInTheDocument()
  })

  it("disables Add until someone is staged or typed", async () => {
    renderPage()
    const input = focusAddInput()
    const addButton = screen.getByRole("button", { name: "Add" })
    expect(addButton).toBeDisabled()

    fireEvent.click(await screen.findByRole("checkbox", { name: "dana" }))
    expect(addButton).toBeEnabled()

    // Clearing the last chip disables Add again.
    fireEvent.click(screen.getByRole("button", { name: "Remove dana" }))
    expect(addButton).toBeDisabled()

    fireEvent.change(input, { target: { value: "someone" } })
    expect(addButton).toBeEnabled()
  })

  it("shows an explicit empty state when every org member already has a grant", async () => {
    orgMocks.roster = [om(1, "alice"), om(3, "carol"), om(4, "erin")]
    renderPage()
    focusAddInput()

    expect(
      await screen.findByText(/all org members are already on this project/i),
    ).toBeInTheDocument()
  })

  it("with no org context (personal project) no suggestion dropdown opens on focus", () => {
    orgMocks.activeOrgId = null
    renderPage()
    focusAddInput()

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/all org members are already on this project/i),
    ).not.toBeInTheDocument()
  })
})
