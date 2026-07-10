import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgHome, activityStatus } from "./OrgHome"
import type { PortfolioProject } from "@/lib/frontier/portfolio"

function projectsRollupStat() {
  const label = screen.getAllByText("Projects").find((el) => el.classList.contains("text-muted-foreground"))!
  return label.parentElement!
}

// Default: signed-in. Type-cast to allow null session in signed-out tests.
type FakeSession = { jwt: string; username: string; createdAt: string } | null
const mockUseFrontierSession = vi.fn<() => { session: FakeSession; loading: boolean }>(() => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => mockUseFrontierSession() }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

// Mock getPortfolio but keep the real validatedPct/attentionRank
vi.mock("@/lib/frontier/portfolio", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/frontier/portfolio")>()
  const now = Date.now()
  return {
    ...actual,
    getPortfolio: vi.fn(async () => [
      // Stalled, low validated — should rank first
      {
        id: "stalled-1",
        name: "Legacy Translation",
        totalCells: 200,
        validatedCells: 20, // 10%
        lastEditAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago (stalled)
        audioCells: 100, // 50% audio
        recordedMs: 120000,
        deadlineAt: "2020-01-01", // long past → overdue
      },
      // Fresh, high validated — should rank second
      {
        id: "fresh-1",
        name: "New Testament",
        totalCells: 100,
        validatedCells: 90, // 90%
        lastEditAt: now, // just edited
        audioCells: 50, // 50% audio
        recordedMs: 60000,
        deadlineAt: null,
      },
    ]),
  }
})

// WorkloadRollup fetches this; empty here so it renders nothing and the
// portfolio-focused assertions below are unaffected.
vi.mock("@/lib/sync/assignments", () => ({ getWorkload: vi.fn(async () => []) }))

// FRO-335/FRO-416: accessible-projects feed for the "Shared with you" section
// (and OrgProvider's guest-org derivation). Default empty — the shared-section
// test overrides it with a foreign-org grant.
const fetchAccessibleProjectsMock = vi.fn(async (): Promise<unknown[]> => [])
vi.mock("@/lib/sync/cloud-projects", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sync/cloud-projects")>()
  return {
    ...actual,
    fetchAccessibleProjects: () => fetchAccessibleProjectsMock(),
  }
})

// FRO-326: pending-invites card data source. Default empty; individual tests
// override to assert the card renders.
const listMyPendingInvitesMock = vi.fn(async (): Promise<unknown[]> => [])
vi.mock("@/lib/sync/invites", () => ({
  listMyPendingInvites: () => listMyPendingInvitesMock(),
}))

// AQU-486: useOrgSettings backs Team workload / Team usage visibility
// (memberProgressViewMinRole). Mocked hermetically (same pattern as
// Settings.test.tsx / ProjectOverview.test.tsx) instead of hitting real fetch.
type OrgSettingsMock = ReturnType<typeof import("@/hooks/useOrgSettings").useOrgSettings>
const defaultOrgSettingsMock = (): OrgSettingsMock => ({
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
  canViewRoster: true,
  rosterViewMinRole: 600,
  canViewMemberProgress: true,
  memberProgressViewMinRole: 600,
  // AQU-496: default leads-only (matches the server's safe default).
  allowSelfAssignment: false,
  refresh: vi.fn(async () => null),
  patch: vi.fn(async () => ({ kind: "ok" as const, value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })),
  requestPromotion: vi.fn(async () => ({ kind: "blocked" as const })),
})
const useOrgSettingsMock = vi.fn<() => OrgSettingsMock>(defaultOrgSettingsMock)
const canEditRosterProgressFloorMock = vi.fn((level: number | null | undefined) => (level ?? 0) >= 700)
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => useOrgSettingsMock(),
  canEditRosterProgressFloor: (level: number | null | undefined) => canEditRosterProgressFloorMock(level),
}))

beforeEach(async () => {
  localStorage.clear()
  mockUseFrontierSession.mockReturnValue({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false })
  // AQU-486: reset the org list back to the default (owner) — the
  // below-floor visibility test overrides this to a contributor-level org,
  // and restoreAllMocks does not undo a persistent mockResolvedValue.
  const { listMyOrgs } = await import("@/lib/frontier/orgs")
  vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
  // Reset to the default (no invites); the pending-invites test overrides this.
  // restoreAllMocks does not reset vi.fn implementations, so without this a
  // mockResolvedValue set in one test would leak into the next.
  listMyPendingInvitesMock.mockResolvedValue([])
  // Same leak-guard for the accessible-projects feed (shared-section test).
  fetchAccessibleProjectsMock.mockResolvedValue([])
  // AQU-486: reset the org-settings mock to its default (everything visible,
  // maintainer floor) — restoreAllMocks does not undo a persistent
  // mockReturnValue set by an earlier test.
  useOrgSettingsMock.mockReturnValue(defaultOrgSettingsMock())
  canEditRosterProgressFloorMock.mockImplementation((level: number | null | undefined) => (level ?? 0) >= 700)
})
afterEach(() => vi.restoreAllMocks())

describe("OrgHome", () => {
  it("renders the org name, nav, and admin links for an owner", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Teams" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Members" })).toBeInTheDocument()
  })

  it("renders both project names from the portfolio", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.getByText("New Testament")).toBeInTheDocument()
  })

  // FRO-326: an invite addressed to the user's email must be discoverable
  // in-app — the email/link may never have arrived. Review & accept routes
  // to the /join/:token confirmation page (explicit accept per FRO-335).
  it("renders the Pending invitations card with a Review & accept link", async () => {
    // mockResolvedValue (not ...Once): OrgHome's invite effect can run more than
    // once (e.g. once before orgs load, once after), and a second call returning
    // the default [] would unmount the card mid-assertion.
    listMyPendingInvitesMock.mockResolvedValue([
      {
        token: "tok-pending-1",
        role: { level: 400, name: "contributor" },
        createdBy: "wendi",
        createdAt: "2026-06-12T00:00:00Z",
        expiresAt: null,
        projects: [{ projectId: "p9", projectName: "Ruth Translation" }],
      },
    ])
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    // The page flashes "Loading…" while the portfolio effect settles, so the card
    // and its link flicker on mount. Assert them together inside one waitFor so the
    // checks all run against a single settled frame (a sync getByRole can otherwise
    // catch a transient frame where the card is unmounted).
    await waitFor(() => {
      const card = screen.getByTestId("pending-invitations")
      expect(card).toHaveTextContent("Ruth Translation")
      expect(card).toHaveTextContent(/invited by wendi/i)
      const link = screen.getByRole("link", { name: /review & accept/i })
      expect(link.getAttribute("href")).toBe("/join/tok-pending-1")
    })
  })

  it("renders no Pending invitations card when there are none", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.queryByTestId("pending-invitations")).not.toBeInTheDocument()
  })

  it("shows the project count in the rollup strip", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    const projectsStat = projectsRollupStat()
    expect(within(projectsStat).getByText("2")).toBeInTheDocument()
  })

  it("shows the overdue rollup card and an overdue badge", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    // "Overdue" appears twice: the rollup card label + the long-past-deadline row badge
    expect(screen.getAllByText("Overdue").length).toBeGreaterThan(1)
  })

  it("shows the audio rollup card and per-project audio % in the project table", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    // Rollup average is still surfaced…
    expect(screen.getByText("Avg audio")).toBeInTheDocument()
    // …and the project list is a table with a dedicated Has Audio column
    // (AQU-489: visible header label, no hover required; "Has Audio" mirrors
    // the ProjectOverview.tsx relabel from AQU-490 for cross-surface
    // consistency)…
    expect(screen.getByText("Has Audio")).toBeInTheDocument()
    // …so each project row shows its own audio coverage (both are 50% audio).
    // Scope to the row so the bare "50%" cell isn't confused with a rollup tile.
    const legacyRow = screen.getByText("Legacy Translation").closest("tr")
    const freshRow = screen.getByText("New Testament").closest("tr")
    expect(legacyRow).not.toBeNull()
    expect(freshRow).not.toBeNull()
    expect(within(legacyRow!).getByText("50%")).toBeInTheDocument()
    expect(within(freshRow!).getByText("50%")).toBeInTheDocument()
  })

  // AQU-489: a PM must be able to name what each progress-table number means
  // without hovering — the column header is the (always-rendered) visible
  // label; a title/hover explanation is optional extra detail, never the
  // only source of meaning. Assert the three metric headers render as plain
  // text nodes (not e.g. only inside a `title` attribute that needs a hover
  // to surface).
  it("labels every progress-table column visibly, without requiring hover (AQU-489)", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    for (const header of ["Translated", "Validated", "Has Audio"]) {
      const el = screen.getByText(header)
      expect(el).toBeInTheDocument()
      // Visible text content, not a title-only attribute — no hover needed.
      expect(el.textContent).toBe(header)
    }
  })

  it("renders the stalled project before the fresh project (attention rank order)", async () => {
    // The default lens is now "recent" (most-recently-edited first); this test
    // specifically verifies the attention-rank ordering, so select that lens.
    localStorage.setItem("org:all-projects:view", "attention")
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    const stalledEl = screen.getByText("Legacy Translation")
    const freshEl = screen.getByText("New Testament")

    // compareDocumentPosition: if stalledEl comes before freshEl,
    // freshEl.compareDocumentPosition(stalledEl) has the PRECEDING bit set (0x2)
    const position = freshEl.compareDocumentPosition(stalledEl)
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it("filters the project list by name without touching the rollup count", async () => {
    // Why: managers narrowing to one project must not see the portfolio
    // headline counts (e.g. total Projects = 2) silently change underneath them.
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Filter projects by name"), {
      target: { value: "testament" },
    })

    expect(screen.queryByText("Legacy Translation")).not.toBeInTheDocument()
    expect(screen.getByText("New Testament")).toBeInTheDocument()
    const projectsStat = projectsRollupStat()
    expect(within(projectsStat).getByText("2")).toBeInTheDocument()
  })

  it("filters to stalled projects via the status chip", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("New Testament")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Stalled" }))

    // Legacy Translation is 30 days stale; New Testament was just edited.
    expect(screen.getByText("Legacy Translation")).toBeInTheDocument()
    expect(screen.queryByText("New Testament")).not.toBeInTheDocument()
  })

  it("shows a no-match message when the filter excludes every project", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Filter projects by name"), {
      target: { value: "nonexistent-zzz" },
    })

    expect(screen.getByText("No results.")).toBeInTheDocument()
  })

  // FRO-416: the dashboard's "Shared with you" section (bottom of the org
  // project list) was the QA repro surface — clicking a shared project
  // "reloaded the page and went nowhere". Root cause was ProjectOverview's
  // pre-FRO-474 org-mismatch redirect; the section itself must render each
  // shared project as a real client-side <Link> to /projects/:id so the
  // click enters the SPA route (no full-page navigation) and the overview
  // can resolve access server-side. Pins both the section rendering and the
  // exact href for a project whose org the caller is NOT a member of.
  it("renders Shared with you rows as client-side links to /projects/:id for foreign-org grants", async () => {
    fetchAccessibleProjectsMock.mockResolvedValue([
      // In the caller's own org (id 1) — must stay OUT of the shared section.
      { id: "own-1", name: "Legacy Translation", orgId: 1, role: { level: 700, name: "owner", source: "creator" }, files: [] },
      // Foreign-org grant (viewer via invite) — the FRO-416 repro row.
      { id: "p503", name: "Guest Gospel", orgId: 503, orgName: "Host Org", role: { level: 100, name: "viewer", source: "override" }, files: [] },
    ])

    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)

    const shared = await screen.findByTestId("shared-with-you")
    const link = within(shared).getByRole("link", { name: /guest gospel/i })
    expect(link.getAttribute("href")).toBe("/projects/p503")
    // Own-org project must not leak into the shared section.
    expect(within(shared).queryByText("Legacy Translation")).not.toBeInTheDocument()
  })
})

// ── AQU-486: per-section visibility chrome ──────────────────────────────────

describe("OrgHome per-section visibility (AQU-486)", () => {
  // WHY: Team workload / Team usage are per-member productivity views gated
  // by the AQU-485 memberProgressViewMinRole floor. A below-floor caller must
  // see nothing (no empty section leaking that workload/usage tracking
  // exists); a permitted caller sees the section with a badge naming who can
  // see it, and — if they can edit — an inline control to change the floor.

  it("hides the Team workload section entirely for a caller below the memberProgressViewMinRole floor", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600, // Maintainer floor
    })
    // Contributor-level org role — below the Maintainer floor.
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 400, name: "contributor" } }])

    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    expect(screen.queryByTestId("section-team-workload")).not.toBeInTheDocument()
    expect(screen.queryByTestId("section-team-usage")).not.toBeInTheDocument()
  })

  it("shows the Team workload section with a visibility badge for a caller meeting the floor", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
    })
    // Default org role in this suite is 700 (owner) — meets the floor.
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    const section = await screen.findByTestId("section-team-workload")
    expect(within(section).getByTestId("section-visibility-badge")).toHaveTextContent(/maintainers & owners/i)
  })

  it("a maintainer can change the Team workload floor via the inline advanced toggle", async () => {
    const patch = vi.fn(async () => ({ kind: "ok" as const, value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } }))
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
      patch,
    })
    canEditRosterProgressFloorMock.mockReturnValue(true)

    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    const section = await screen.findByTestId("section-team-workload")
    fireEvent.click(within(section).getByTestId("section-visibility-badge"))

    const trigger = await screen.findByRole("combobox", { name: /who can see this section/i })
    fireEvent.click(trigger)
    const option = await screen.findByRole("option", { name: /everyone with access/i })
    fireEvent.pointerMove(option)
    fireEvent.mouseMove(option)
    fireEvent.keyDown(option, { key: "Enter" })

    await waitFor(() => expect(patch).toHaveBeenCalledWith({ memberProgressViewMinRole: 100 }))
  })
})

// FRO-293: signed-out state — no fake-empty dashboard
describe("OrgHome signed-out state", () => {
  it("shows a sign-in prompt instead of zero-stat cards when there is no session", async () => {
    // Why: a signed-out user at / must never see '0 Projects / 0% translated' cards
    // which falsely imply the workspace is empty.
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument()
    })

    // The stat rollup cards must not be present — they'd show meaningless zeros.
    expect(screen.queryByText("0%")).not.toBeInTheDocument()
    expect(screen.queryByText("Avg translated")).not.toBeInTheDocument()
    expect(screen.queryByText("No projects in this org yet.")).not.toBeInTheDocument()
  })

  it("sign-in link on the signed-out state points to /login with next=/", async () => {
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)

    const link = await screen.findByRole("link", { name: /sign in/i })
    expect(link.getAttribute("href")).toMatch(/\/login\?next=/)
  })
})

describe("activityStatus", () => {
  const now = Date.now()
  const base: PortfolioProject = {
    id: "p", name: "P", totalCells: 100, validatedCells: 0, filledCells: 0, aiDraftedCells: 0,
    lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null,
  }

  it("treats a never-edited, never-translated project as not-started, not stalled", () => {
    // Why: a freshly seeded project hasn't lost momentum — flagging it red as
    // "Stalled" misleads the owner-oversight dashboard.
    expect(activityStatus({ ...base, lastEditAt: null, filledCells: 0 }, now)).toBe("not-started")
  })

  it("treats a project that had activity then went quiet 14+ days as stalled", () => {
    expect(
      activityStatus({ ...base, lastEditAt: now - 30 * 24 * 60 * 60 * 1000, filledCells: 50 }, now),
    ).toBe("stalled")
  })

  it("treats translated-but-never-timestamped work as stalled, not not-started", () => {
    // filledCells > 0 means real work exists even if lastEditAt is missing.
    expect(activityStatus({ ...base, lastEditAt: null, filledCells: 10 }, now)).toBe("stalled")
  })

  it("treats a recently edited project as active", () => {
    expect(activityStatus({ ...base, lastEditAt: now, filledCells: 5 }, now)).toBe("active")
  })
})
