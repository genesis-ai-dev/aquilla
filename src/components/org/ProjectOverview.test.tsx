import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react"
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectOverview, deriveProjectStatus } from "./ProjectOverview"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { fmtDeadlineDate } from "@/lib/format-date"

const navigate = vi.fn()
vi.mock("react-router-dom", async (importActual) => {
  const actual = await importActual<typeof import("react-router-dom")>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
  listOrgMembers: vi.fn(async () => []),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("./ProjectAutopilotPanel", () => ({
  ProjectAutopilotPanel: ({ canStart }: { canStart: boolean }) => (
    <div data-testid="project-autopilot-panel-mock" data-can-start={String(canStart)} />
  ),
}))

const useProject = vi.fn()
const refresh = vi.fn()
vi.mock("@/hooks/useProject", () => ({ useProject: (...a: unknown[]) => useProject(...a) }))

const archiveProjectRemote = vi.fn()
const unarchiveProjectRemote = vi.fn()
vi.mock("@/lib/sync/archive", () => ({
  archiveProjectRemote: (...a: unknown[]) => archiveProjectRemote(...a),
  unarchiveProjectRemote: (...a: unknown[]) => unarchiveProjectRemote(...a),
}))

type PortfolioProject = import("@/lib/frontier/portfolio").PortfolioProject

// deadlineStatus stub — we control it per test via module-level variable
let _deadlineStatusResult: "overdue" | "soon" | "ok" | null = null
const getPortfolio = vi.fn((_jwt: string, _orgId: number): Promise<PortfolioProject[]> => Promise.resolve([]))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: (jwt: string, orgId: number) => getPortfolio(jwt, orgId),
  // Real implementations — tests must not override these with wrong stubs
  audioPct: (p: { audioCells: number; totalCells: number }) => (p.totalCells > 0 ? p.audioCells / p.totalCells : 0),
  // AQU-1093: denominator is totalCells, so the tile agrees with the plan
  // board's bars. The of-recorded ratio moved to the tooltip.
  audioValidatedPct: (p: { validatedAudioCells: number; totalCells: number }) =>
    (p.totalCells > 0 ? Math.min(1, p.validatedAudioCells / p.totalCells) : 0),
  audioValidatedOfRecordedPct: (p: { validatedAudioCells: number; audioCells: number }) =>
    (p.audioCells > 0 ? Math.min(1, p.validatedAudioCells / p.audioCells) : 0),
  translatedPct: (p: { filledCells: number; totalCells: number }) => (p.totalCells > 0 ? p.filledCells / p.totalCells : 0),
  validatedPct: (p: { validatedCells: number; totalCells: number }) => (p.totalCells > 0 ? p.validatedCells / p.totalCells : 0),
  aiDraftedPct: (p: { aiDraftedCells: number; totalCells: number }) => (p.totalCells > 0 ? p.aiDraftedCells / p.totalCells : 0),
  recordedMinutes: (p: { recordedMs: number }) => Math.round(p.recordedMs / 60000),
  deadlineStatus: () => _deadlineStatusResult,
  // AQU-1092…1098: plan-status.ts imports these to decide overdue/due-soon.
  // Real implementations, not stubs — a unit and its project must agree about
  // what "late" means, and a wrong stub here would hide that.
  AOE_GRACE_MS: (24 + 12) * 60 * 60 * 1000,
  DEADLINE_SOON_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  isDeadlineOverdue: (deadlineUtcMidnight: number, nowMs: number) =>
    nowMs >= deadlineUtcMidnight + (24 + 12) * 60 * 60 * 1000,
  // AQU-538 §3.3: real per-lane helpers so the lane table/tiles compute true %s.
  laneTranslatedPct: (l: { filledCells: number; totalCells: number }) => (l.totalCells > 0 ? l.filledCells / l.totalCells : 0),
  laneValidatedPct: (l: { validatedCells: number; totalCells: number }) => (l.totalCells > 0 ? l.validatedCells / l.totalCells : 0),
}))

// AQU-538 §3.3: the lane table mounts AssignModal + StaffLanePopover per lane.
// Stub both to capture the lane they were handed (defaultLane / lane) without
// pulling their whole fetch surface into this suite.
vi.mock("@/components/AssignModal", () => ({
  AssignModal: ({ open, defaultLane }: { open: boolean; defaultLane?: string }) =>
    open ? <div data-testid="assign-modal-mock" data-lane={defaultLane ?? ""} /> : null,
}))
vi.mock("@/components/StaffLanePopover", () => ({
  StaffLanePopover: ({ lane, laneLabel }: { lane: string; laneLabel: string }) => (
    <div data-testid="staff-lane-mock" data-lane={lane} data-label={laneLabel} />
  ),
}))
vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopes: vi.fn(async () => []),
  putMemberScopes: vi.fn(async () => []),
}))
const setProjectPm = vi.fn(async (_jwt: string, _projectId: string, _pmUserId: number | null): Promise<{ id: number; username: string } | null> => null)
const setProjectDeadline = vi.fn(async (_jwt: string, _projectId: string, _deadline: string | null): Promise<void> => {})
// OrgSidebar (rendered by ProjectOverview's AppShell) calls
// useProjectsForNavigation -> fetchAccessibleProjects for the "Shared with
// you" nav section (AQU-474), and OrgProvider fetches the same directory
// (the org overview's PM column joins from it, AQU-507). Default to empty so
// it never interferes with pre-existing tests.
const fetchAccessibleProjects = vi.fn(async (_jwt: string): Promise<unknown[]> => [])
// Spread the real module rather than replacing it: ProjectOverview's tree
// reaches cloud-projects through several paths (useProject -> resolveCloudProjectResult
// / minimalProjectRecord, SharePanel, useProjectOrgId), and a factory listing
// only the three functions this file drives makes every one of those an
// "export is not defined on the mock" failure the moment a new caller appears.
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/cloud-projects")>()),
  setProjectDeadline: (jwt: string, projectId: string, deadline: string | null) => setProjectDeadline(jwt, projectId, deadline),
  setProjectPm: (jwt: string, projectId: string, pmUserId: number | null) => setProjectPm(jwt, projectId, pmUserId),
  fetchAccessibleProjects: (jwt: string) => fetchAccessibleProjects(jwt),
  fetchAccessibleProjectsResult: async (jwt: string) => ({
    ok: true as const,
    projects: await fetchAccessibleProjects(jwt),
  }),
  resolveCloudProjectResult: vi.fn(async () => ({ ok: true as const, project: { id: "p1", orgId: 1 } })),
}))
const downloadProjectBundle = vi.fn()
vi.mock("@/lib/sync/export-bundle", () => ({
  downloadProjectBundle: (...a: unknown[]) => downloadProjectBundle(...a),
}))

// AQU-500: stub the shared download helper so CSV-export tests can assert on
// the blob/filename it was called with, without touching the DOM anchor click.
const downloadBlob = vi.fn()
vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
}))

const fetchSyncToken = vi.fn()
vi.mock("@/lib/sync/sync-token", () => ({
  fetchSyncToken: (...a: unknown[]) => fetchSyncToken(...a),
}))
const fetchProjectFiles = vi.fn()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: (...a: unknown[]) => fetchProjectFiles(...a),
}))
const fetchProjectPlan = vi.fn()
const setPlanUnit = vi.fn()
vi.mock("@/lib/sync/plan", () => ({
  fetchProjectPlan: (...a: unknown[]) => fetchProjectPlan(...a),
  setPlanUnit: (...a: unknown[]) => setPlanUnit(...a),
}))

const getFileProgress = vi.fn()
const getFileSectionProgress = vi.fn()
vi.mock("@/lib/progress/file-progress-resource", () => ({
  getFileProgress: (...a: unknown[]) => getFileProgress(...a),
  getFileSectionProgress: (...a: unknown[]) => getFileSectionProgress(...a),
}))

// Mock assignments workload so Team card doesn't break tests
vi.mock("@/lib/sync/assignments", () => ({
  getWorkload: vi.fn(async () => []),
  getProjectAssignments: vi.fn(async () => []),
  getMyAssignments: vi.fn(async () => []),
}))

// AQU-498: member-activity fetch, consumed by useMemberActivity ->
// MemberActivityPanel when a Team-card row's "Activity" affordance is clicked.
const fetchMemberActivity = vi.fn()
vi.mock("@/lib/sync/member-activity-read", () => ({
  fetchMemberActivity: (...a: unknown[]) => fetchMemberActivity(...a),
}))

// AQU-486: useOrgSettings backs the per-section visibility floors
// (rosterViewMinRole / memberProgressViewMinRole). Mocked hermetically here
// (same pattern as Settings.test.tsx) rather than letting it hit real fetch —
// individual describe blocks override the return value per test.
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
  // AQU-822: default termbase-edit floor (project_lead), as the server resolves it.
  termbaseEditMinRole: 500,
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

function projectRecord(over: Partial<ProjectRecord> & { level: number; deletedAt?: string }): ProjectRecord {
  const { level, deletedAt, ...rest } = over
  return {
    id: "p1",
    name: "John",
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: "2026-01-01",
    files: [],
    members: [],
    syncRole: { level, name: "x", source: "org", fetchedAt: "2026-01-01" },
    ...(deletedAt ? { deletedAt } : {}),
    ...rest,
  } as ProjectRecord
}

function SettingsLocationProbe() {
  const location = useLocation()
  const state = location.state as {
    backgroundLocation?: { pathname?: string }
    projectSettingsModalDepth?: number
  } | null
  return (
    <div
      data-testid="settings-location"
      data-background={state?.backgroundLocation?.pathname}
      data-depth={state?.projectSettingsModalDepth}
    />
  )
}

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <OrgProvider>
        <Routes>
          <Route path="/projects/:id" element={<ProjectOverview />} />
          <Route path="/project/:id/settings" element={<SettingsLocationProbe />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  localStorage.clear()
  _deadlineStatusResult = null
  // Some AQU-474 tests override this to simulate a user with no orgs;
  // vi.clearAllMocks() clears call history but not mockResolvedValue
  // implementations, so restore the default (single org, auto-selected) here.
  const { listMyOrgs } = await import("@/lib/frontier/orgs")
  vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
  // AQU-486: reset the org-settings mock to its default (everything visible,
  // maintainer floor) — vi.clearAllMocks() does not undo a persistent
  // mockReturnValue set by an earlier test.
  useOrgSettingsMock.mockReturnValue(defaultOrgSettingsMock())
  // AQU-1092…1098: an empty but well-formed plan by default, so the board
  // renders its empty state rather than an error in unrelated tests.
  fetchProjectPlan.mockResolvedValue({ projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [] })
  // The plan mints a sync token like the file list does; without a default,
  // whether a test sees units depends on which test ran before it.
  fetchSyncToken.mockResolvedValue({ token: "tok" })
  canEditRosterProgressFloorMock.mockImplementation((level: number | null | undefined) => (level ?? 0) >= 700)
})
afterEach(() => vi.clearAllMocks())

/** Build a FileSummary stub for testing the file list. */
function fileSummary(i: number): import("@/lib/sync/cells-read").FileSummary {
  return { fileId: `f${i}`, projectId: "p1", name: `File${i}.usfm`, fileType: "usfm", sourceLanguage: null, targetLanguage: null, cellCount: 10, filledCount: 5, approvedCount: 2, wordCount: 100, lastEditAt: null }
}


// ── Status chip derivation ─────────────────────────────────────────────────

describe("deriveProjectStatus", () => {
  // WHY: the status chip is the primary at-a-glance signal for managers (Wendi/Anna).
  // The derivation must map correctly from deadline + progress to the three chip states.

  function makePortfolio(opts: Partial<PortfolioProject> = {}): PortfolioProject {
    return {
      id: "p1", name: "Test", totalCells: 100, filledCells: 50, validatedCells: 20,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null, ...opts,
    }
  }

  const NOW = new Date("2026-06-05").getTime()

  it("returns 'no-deadline' when portfolio is null", () => {
    expect(deriveProjectStatus(null, NOW)).toBe("no-deadline")
  })

  it("returns 'no-deadline' when no deadlineAt set", () => {
    expect(deriveProjectStatus(makePortfolio({ deadlineAt: null }), NOW)).toBe("no-deadline")
  })

  it("maps deadlineStatus results to chip states correctly", () => {
    // deriveProjectStatus calls the module's deadlineStatus (mocked in tests).
    // Set _deadlineStatusResult to control what the mock returns and verify the mapping.
    const pastDate = new Date(NOW - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const soonDate = new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const farDate = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    _deadlineStatusResult = "overdue"
    expect(deriveProjectStatus(makePortfolio({ deadlineAt: pastDate }), NOW)).toBe("overdue")
    _deadlineStatusResult = "soon"
    expect(deriveProjectStatus(makePortfolio({ deadlineAt: soonDate }), NOW)).toBe("due-soon")
    _deadlineStatusResult = "ok"
    expect(deriveProjectStatus(makePortfolio({ deadlineAt: farDate }), NOW)).toBe("on-track")
  })
})

function portfolioWithDeadline(deadlineAt: string): PortfolioProject {
  return {
    id: "p1",
    name: "John",
    totalCells: 10,
    filledCells: 1,
    validatedCells: 0,
    aiDraftedCells: 0,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    lastEditAt: null,
    deadlineAt,
    sourceLanguage: null,
    targetLanguage: null,
  }
}

describe("ProjectOverview status chip placement", () => {
  beforeEach(() => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 600 }),
      status: "ready",
      refresh,
    })
  })

  it("shows On track only next to the title, not next to the deadline", async () => {
    _deadlineStatusResult = "ok"
    getPortfolio.mockResolvedValue([portfolioWithDeadline("2033-12-31")])
    renderOverview()

    await screen.findByText(fmtDeadlineDate("2033-12-31"))
    expect(screen.getAllByText("On track")).toHaveLength(1)
    expect(
      within(screen.getByRole("heading", { name: "John" }).parentElement!).getByText("On track"),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId("overview-project-meta")).queryByText("On track")).not.toBeInTheDocument()
  })

  it.each([
    ["overdue", "Overdue"],
    ["soon", "Due soon"],
  ] as const)("shows %s only next to the deadline, not next to the title", async (status, label) => {
    _deadlineStatusResult = status
    getPortfolio.mockResolvedValue([portfolioWithDeadline("2026-07-01")])
    renderOverview()

    await screen.findByText(fmtDeadlineDate("2026-07-01"))
    expect(screen.getAllByText(label)).toHaveLength(1)
    expect(
      within(screen.getByRole("heading", { name: "John" }).parentElement!).queryByText(label),
    ).not.toBeInTheDocument()
    expect(within(screen.getByTestId("overview-project-meta")).getByText(label)).toBeInTheDocument()
  })
})

describe("ProjectOverview load states", () => {
  it("shows explicit progress over the project-shaped template while details load", () => {
    useProject.mockReturnValue({
      project: null,
      status: "loading",
      refresh,
    })

    renderOverview()

    const status = screen.getByRole("status", {
      name: "Loading project details",
    })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
    expect(screen.getByText("Loading project details…")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 1, name: "John" })).not.toBeInTheDocument()
  })

  it("shows retry UI for unreachable project loads instead of an endless loading state", async () => {
    useProject.mockReturnValue({
      project: null,
      status: "unreachable",
      refresh,
    })

    renderOverview()

    expect(await screen.findByText(/can't reach the server/i)).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("shows a sign-in state when the project cannot load because there is no session", async () => {
    useProject.mockReturnValue({
      project: null,
      status: "no-session",
      refresh,
    })

    renderOverview()

    expect(await screen.findByText(/sign in to see your workspace/i)).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()

    const signIn = screen.getByRole("link", { name: /^sign in$/i })
    expect(signIn).toHaveAttribute("href", "/login?next=%2Fprojects%2Fp1")
  })
})

describe("ProjectOverview Autopilot discovery flag", () => {
  it("hides the overview surface when contextualTranslation is opted out", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    getPortfolio.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({
        level: 700,
        experimentalFlags: { contextualTranslation: false },
      }),
      status: "ready",
      refresh,
    })

    renderOverview()

    await screen.findByRole("heading", { level: 1, name: "John" })
    expect(screen.queryByTestId("project-autopilot-panel-mock")).not.toBeInTheDocument()
  })

  it("hides the overview surface when the project has never opted in", async () => {
    // AQU-1103 regression guard, at the surface the bug was reported on: a PM's
    // project overview. This is the production shape — no `experimentalFlags`
    // on the record at all — which used to fall through to a default-on
    // registry entry and render an Autopilot panel reporting "Needs attention"
    // on a project nobody had enrolled.
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    getPortfolio.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 700 }),
      status: "ready",
      refresh,
    })

    renderOverview()

    await screen.findByRole("heading", { level: 1, name: "John" })
    expect(screen.queryByTestId("project-autopilot-panel-mock")).not.toBeInTheDocument()
  })

  it("shows the overview surface once the project has opted in", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    getPortfolio.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({
        level: 700,
        experimentalFlags: { contextualTranslation: true },
      }),
      status: "ready",
      refresh,
    })

    renderOverview()

    expect(await screen.findByTestId("project-autopilot-panel-mock")).toBeInTheDocument()
  })

  it("uses the fresh resolved role for Autopilot controls instead of the stale project cache", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    getPortfolio.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({
        level: 700,
        experimentalFlags: { contextualTranslation: true },
      }),
      roleLevel: ROLE.VIEWER,
      status: "ready",
      refresh,
    })

    renderOverview()

    expect(await screen.findByTestId("project-autopilot-panel-mock")).toHaveAttribute(
      "data-can-start",
      "false",
    )
  })
})

// ── Per-metric conditionality ──────────────────────────────────────────────

describe("ProjectOverview per-metric conditionality (AQU-168)", () => {
  // WHY: audio-only projects must hide text metrics; text-only must hide audio.
  // Showing irrelevant metrics confuses managers scanning project state.

  it("text-only project: shows Translated/Validated tiles but hides Has Audio / Audio Validated tiles", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 80, validatedCells: 50,
      aiDraftedCells: 0,
      audioCells: 0, // no audio
      validatedAudioCells: 0,
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    // Translated and Validated tiles should appear (text content present)
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Validated").length).toBeGreaterThan(0)
    // Neither audio tile may appear (audioCells === 0) — AQU-490: this also
    // guards against a false-positive "Audio Validated" figure on a
    // text-only project, since neither field exists to fabricate one from.
    expect(screen.queryByText("Has audio")).not.toBeInTheDocument()
    expect(screen.queryByText("Audio Validated")).not.toBeInTheDocument()
  })

  it("audio-only project: shows Has Audio + a real Audio Validated percentage", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100,
      filledCells: 0, // no text
      validatedCells: 0,
      aiDraftedCells: 0,
      audioCells: 60, // audio present
      validatedAudioCells: 15, // 15 of 100 cells = 15%; 15 of 60 recorded = 25%
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    // Has Audio (coverage) tile should appear
    await waitFor(() => expect(screen.getAllByText("Has audio").length).toBeGreaterThan(0))
    // Translated and Validated must NOT appear (filledCells === 0 means showText is false,
    // but note: totalCells > 0 means hasText=true in current logic which guards on totalCells.
    // The real guard is audioCells > 0 for audio, and totalCells > 0 for text.
    // For audio-only: filledCells=0 but totalCells=100, so text bars still show.
    // Per AQU-168 spec: hide text metrics only when "no text content (translatable cells > 0)".
    // totalCells > 0 means there IS translatable content, so text bars appear even if empty.
    // The audio-only guard is specifically: audioCells > 0 shows Has Audio, always shows text when totalCells > 0.
    // This test therefore confirms Has Audio appears when audioCells > 0.
    expect(screen.getAllByText("Has audio").length).toBeGreaterThan(0)
    // AQU-1092: the tile used to render a hardcoded "N/A" because the metric
    // was said not to exist. It does (cell_audio.approved, counted by the org
    // portfolio), so the tile shows a real number.
    // AQU-1093: that number is 15 of 100 CELLS = 15%, not 15 of 60 takes = 25%
    // — the tile and the plan board's audio bar must report the same share.
    expect(screen.getByText("Audio Validated")).toBeInTheDocument()
    expect(screen.getByText("15%")).toBeInTheDocument()
    expect(screen.queryByText("N/A")).not.toBeInTheDocument()
  })

  // AQU-489: a PM who has never seen the dashboard must be able to name what
  // each progress number means without hovering. Every tile/bar label below
  // is rendered as plain visible text (not just a `title`/tooltip attribute)
  // — hover (AppTooltip) adds extra detail on top, it is never the only
  // source of meaning. Terminology ("Has Audio" / "Audio Validated") must
  // match OrgHome.tsx's project table (see OrgHome.test.tsx AQU-489 test).
  it("labels every progress number visibly, without requiring hover (AQU-489)", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 80, validatedCells: 50,
      aiDraftedCells: 0,
      audioCells: 60,
      validatedAudioCells: 0,
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    for (const label of ["Translated", "Validated", "Has audio", "Audio Validated"]) {
      await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0))
    }
  })

  // AQU-593: managers can hide stat widgets they don't find helpful. The
  // preference is a per-user localStorage setting, honored at render time.
  it("hides a stat widget when its key is persisted as hidden (AQU-593)", async () => {
    localStorage.setItem("aquilla:hiddenStats", JSON.stringify(["validated"]))
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 80, validatedCells: 50,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0,
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    // Translated still shows; Validated is hidden by the persisted preference.
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    expect(screen.queryByText("Validated")).not.toBeInTheDocument()
    // The Customize control is present so the user can bring it back.
    expect(screen.getByTestId("customize-stats-trigger")).toBeInTheDocument()
  })

  it("Customize menu toggles a stat off and persists the choice (AQU-593)", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 80, validatedCells: 50,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0,
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    const card = await screen.findByTestId("progress-card")
    await waitFor(() => expect(within(card).getAllByText("Validated").length).toBeGreaterThan(0))
    fireEvent.click(screen.getByTestId("customize-stats-trigger"))
    const validatedToggle = await screen.findByTestId("customize-stat-validated")
    fireEvent.click(validatedToggle)

    // The Validated tile + bar disappear from the Progress card (the menu item,
    // portaled outside the card, keeps its own "Validated" label) and the
    // choice is persisted for next mount.
    await waitFor(() => expect(within(card).queryByText("Validated")).not.toBeInTheDocument())
    expect(JSON.parse(localStorage.getItem("aquilla:hiddenStats") ?? "[]")).toContain("validated")
    // Translated is untouched.
    expect(within(card).getAllByText("Translated").length).toBeGreaterThan(0)
  })
})

// ── Archive / restore ──────────────────────────────────────────────────────

describe("ProjectOverview archive/restore", () => {
  const ARCHIVE_CHECKBOX =
    "I understand this project will be hidden from the active list."

  it("owner sees Archive in overflow; confirming archives and returns to /projects", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    archiveProjectRemote.mockResolvedValue({ kind: "archived", archivedAt: "now", archivedBy: { id: 1, username: "wendi" } })
    renderOverview()

    // Open the overflow menu first
    const moreBtn = await screen.findByRole("button", { name: "More actions" })
    fireEvent.click(moreBtn)

    const btn = await screen.findByRole("menuitem", { name: "Archive" })
    fireEvent.click(btn)

    // Confirm dialog — archive does not run until the checkbox is checked.
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(archiveProjectRemote).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled()

    fireEvent.click(screen.getByText(ARCHIVE_CHECKBOX))
    fireEvent.click(screen.getByRole("button", { name: "Archive" }))

    await waitFor(() => expect(archiveProjectRemote).toHaveBeenCalledWith("p1", "jwt"))
    expect(navigate).toHaveBeenCalledWith("/orgs/1/projects")
  })

  it("canceling the archive dialog does not archive", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    fireEvent.click(await screen.findByRole("button", { name: "More actions" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }))

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(archiveProjectRemote).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("non-owner does not see the overflow menu (no archive)", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 100 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument()
  })

  it("owner of an archived project sees Restore + Archived badge", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700, deletedAt: "2026-05-01" }), status: "ready", refresh })
    unarchiveProjectRemote.mockResolvedValue({ kind: "restored" })
    renderOverview()

    expect(await screen.findByText("Archived")).toBeInTheDocument()
    const btn = screen.getByRole("button", { name: "Restore" })
    fireEvent.click(btn)

    await waitFor(() => expect(unarchiveProjectRemote).toHaveBeenCalledWith("p1", "jwt"))
  })

  it("maintainer sees Download deliverable in overflow; clicking triggers the bundle download", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 600, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 0 }] }),
      status: "ready",
      refresh,
    })
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    downloadProjectBundle.mockResolvedValue(undefined)
    renderOverview()

    // Open overflow
    const moreBtn = await screen.findByRole("button", { name: "More actions" })
    fireEvent.click(moreBtn)

    const btn = await screen.findByRole("menuitem", { name: "Download deliverable" })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(downloadProjectBundle).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", fileId: "f1" })),
    )
  })

  it("non-maintainer does not see the overflow menu", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 0 }] }),
      status: "ready",
      refresh,
    })
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Download deliverable" })).not.toBeInTheDocument()
  })
})

// ── Project manager (AQU-507) ──────────────────────────────────────────────

describe("ProjectOverview PM assignment", () => {
  // WHY: the org overview's PM column joins from the app-wide accessible-
  // projects directory (OrgContext, fetched once per session). A PM change
  // that only refreshes this page's own project row leaves that directory
  // stale, so the org overview kept showing the old PM until a hard reload.
  it("saving a PM change revalidates the accessible-projects directory", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 600 }),
      status: "ready",
      refresh,
      pm: { id: 7, username: "wendi" },
    })
    renderOverview()

    expect(await screen.findByTestId("overview-pm-name")).toHaveTextContent("wendi")
    expect(screen.getByTestId("overview-project-meta")).toBeInTheDocument()
    // Let the provider's mount-time directory fetch resolve first: OrgContext
    // dedupes refreshes into an in-flight request for the same JWT, so a
    // still-pending initial fetch would absorb the post-save revalidation.
    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalled())
    const callsBeforeSave = fetchAccessibleProjects.mock.calls.length

    const meta = screen.getByTestId("overview-project-meta")
    expect(within(meta).queryByRole("button", { name: "Change" })).not.toBeInTheDocument()
    expect(within(meta).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Change project manager" }))
    expect(screen.getByRole("heading", { name: "Change project manager" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))

    await waitFor(() => expect(setProjectPm).toHaveBeenCalledWith("jwt", "p1", null))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    await waitFor(() =>
      expect(fetchAccessibleProjects.mock.calls.length).toBeGreaterThan(callsBeforeSave),
    )
  })

  it("clears the deadline from the edit-dialog Clear control", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 600 }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1",
      name: "John",
      totalCells: 10,
      filledCells: 1,
      validatedCells: 0,
      aiDraftedCells: 0,
      audioCells: 0,
      validatedAudioCells: 0,
      recordedMs: 0,
      lastEditAt: null,
      deadlineAt: "2026-07-01",
      sourceLanguage: null,
      targetLanguage: null,
    }])
    renderOverview()

    await screen.findByText(fmtDeadlineDate("2026-07-01"))
    const meta = screen.getByTestId("overview-project-meta")
    expect(within(meta).queryByRole("button", { name: "Change" })).not.toBeInTheDocument()
    expect(within(meta).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Change project deadline" }))
    expect(screen.getByRole("heading", { name: "Change project deadline" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(setProjectDeadline).toHaveBeenCalledWith("jwt", "p1", null))
  })
})

// ── Audio progress ─────────────────────────────────────────────────────────

describe("ProjectOverview audio progress (AQU-160)", () => {
  // WHY: audio progress was showing 0% on all projects even when recordings
  // existed. The portfolio endpoint computes audioCells from the cell_audio
  // table; if it returns non-zero, the overview MUST display a non-zero
  // percentage — not a hardcoded 0. These tests verify the rendering path
  // end-to-end so a stale stub can never mask a regression.
  it("shows non-zero audio % when the portfolio returns audioCells > 0", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([
      {
        id: "p1",
        name: "John",
        totalCells: 100,
        filledCells: 80,
        validatedCells: 50,
        aiDraftedCells: 0,
        audioCells: 30,   // 30 cells have recordings → 30%
        validatedAudioCells: 0,
        recordedMs: 90000,
        lastEditAt: Date.now(),
        deadlineAt: null,
        sourceLanguage: null,
        targetLanguage: null,
      },
    ])

    renderOverview()

    // The progress section should be present (totalCells > 0).
    // The "Has Audio" label must appear in the StatBar list (AQU-490 relabel).
    await waitFor(() => expect(screen.getAllByText("Has audio").length).toBeGreaterThan(0))
    // The audio StatBar displays "30%" in its percentage column.
    // getAllByText because translated (80%) and validated (50%) also render %.
    const pctLabels = screen.getAllByText(/^\d+%$/)
    // At least one label should show 30% (the audio bar).
    expect(pctLabels.map((el) => el.textContent)).toContain("30%")
  })

  it("shows 0% audio on a project that genuinely has no recordings", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([
      {
        id: "p1",
        name: "John",
        totalCells: 100,
        filledCells: 80,
        validatedCells: 50,
        aiDraftedCells: 0,
        audioCells: 0,    // no recordings at all → correct 0%
        validatedAudioCells: 0,
        recordedMs: 0,
        lastEditAt: Date.now(),
        deadlineAt: null,
        sourceLanguage: null,
        targetLanguage: null,
      },
    ])

    renderOverview()

    // When audioCells === 0, Has Audio tile/bar is hidden (per-metric conditionality).
    // So we just confirm the progress section renders with text metrics.
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    // Audio tiles should be hidden
    expect(screen.queryByText("Has audio")).not.toBeInTheDocument()
    expect(screen.queryByText("Audio Validated")).not.toBeInTheDocument()
  })
})

// ── AQU-474: project-only invitee navigation ────────────────────────────────

describe("ProjectOverview project-only invitee access (AQU-474)", () => {
  // WHY: a user with a direct project_members grant but no org membership
  // (activeOrgId == null, or an org that doesn't include this project) was
  // being redirected straight back to "/" — they could never open their own
  // shared project. useProject is server-verified per-project access, so the
  // overview must render whenever status === "ready", and only redirect on a
  // genuine "not-found" (no access).

  it("renders the overview (no redirect) when activeOrgId is null and the user has a direct project grant", async () => {
    // No orgs at all → OrgProvider resolves activeOrgId to null.
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockResolvedValue([])

    useProject.mockReturnValue({
      project: projectRecord({ level: 400, orgId: 99, files: [] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([])

    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("renders the overview (no redirect) when the project's orgId does not match activeOrgId", async () => {
    // OrgProvider auto-selects the single org (id 1) from listMyOrgs (default mock).
    // The project belongs to org 99 — a mismatch that pre-AQU-474 triggered a redirect.
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, orgId: 99, files: [] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([])

    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("falls back to the project's own orgId to load portfolio stats when activeOrgId is null", async () => {
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockResolvedValue([])

    useProject.mockReturnValue({
      project: projectRecord({ level: 400, orgId: 99, files: [] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 50, validatedCells: 20,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])

    renderOverview()

    // Portfolio was queried using the project's own orgId (99), not activeOrgId (null).
    await waitFor(() => expect(getPortfolio).toHaveBeenCalledWith("jwt", 99))
    expect(navigate).not.toHaveBeenCalled()
  })

  it("still redirects to / when the user genuinely has no access (status = not-found)", async () => {
    useProject.mockReturnValue({ project: null, status: "not-found", refresh })

    renderOverview()

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/", { replace: true }))
  })

  // AQU-416: the overview rendering (no redirect) is necessary but not
  // sufficient — a guest must be able to actually ENTER the workspace from
  // here. "Open project" navigates unconditionally to `/project/:id/editor`; this
  // locks in that the button still fires for a project whose org the caller
  // does not belong to (the exact "Shared with you" scenario), so a future
  // regression that guards this button on org membership fails loudly here
  // instead of only surfacing as a live "clicking does nothing" report.
  it("clicking Open project navigates into the workspace even when the project's org is foreign to the caller", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, orgId: 99, files: [] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([])

    renderOverview()

    const openButton = await screen.findByRole("button", { name: "Open project" })
    fireEvent.click(openButton)

    // AQU-737: Open project now routes through useOpenWorkspace (navigate wrapped
    // in a transition so the button can spin); it still navigates to the
    // workspace, forwarding an optional NavigateOptions arg.
    expect(
      navigate.mock.calls.some((call: unknown[]) => call[0] === "/project/p1/editor"),
    ).toBe(true)
  })

  it("opens Project settings as a route modal over the overview", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([])

    renderOverview()

    const settings = await screen.findByRole("link", { name: "Project settings" })
    expect(settings).toHaveAttribute("href", "/project/p1/settings")
    fireEvent.click(settings)

    const destination = await screen.findByTestId("settings-location")
    expect(destination).toHaveAttribute("data-background", "/projects/p1")
    expect(destination).toHaveAttribute("data-depth", "1")
  })
})

// ── AQU-292: AI-drafted segment ─────────────────────────────────────────────

describe("ProjectOverview AI-drafted segment (AQU-292)", () => {
  // WHY: manager-facing overview must surface AI-drafted volume as a distinct
  // third segment so owners (Wendi/Anna) know how much AI batch output is
  // awaiting human review, not counting it as "human-translated" work.

  it("shows AI Drafted tile and bar when aiDraftedCells > 0", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100,
      filledCells: 80,
      validatedCells: 30,
      aiDraftedCells: 40, // 40 AI-drafted cells awaiting review
      audioCells: 0,
      validatedAudioCells: 0,
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    // "AI Drafted" tile and bar must appear when aiDraftedCells > 0
    await waitFor(() => expect(screen.getAllByText("AI Drafted").length).toBeGreaterThan(0))
    // 40/100 = 40% should appear somewhere in the progress section
    const pctLabels = screen.getAllByText(/^\d+%$/)
    expect(pctLabels.map((el) => el.textContent)).toContain("40%")
  })

  it("hides AI Drafted segment when aiDraftedCells = 0 (human-translated project or pre-marker history)", async () => {
    // WHY: forward-only honesty — projects whose AI commits predate the marker
    // show aiDraftedCells = 0 and must NOT show a misleading "0% AI Drafted" tile.
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100,
      filledCells: 80, validatedCells: 50,
      aiDraftedCells: 0, // no tracked AI drafts
      audioCells: 0, validatedAudioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    // "AI Drafted" must NOT appear when count is 0 (forward-only honest rendering)
    expect(screen.queryByText("AI Drafted")).not.toBeInTheDocument()
  })
})

// ── AQU-486: per-section visibility chrome ──────────────────────────────────

describe("ProjectOverview roster lives in project settings", () => {
  // WHY: the overview used to embed MembersTab (add / change-role / revoke)
  // under a visibility-gated card. That roster is now only in Project
  // Settings → Team members. Overview still has the Team *progress* card
  // (assignments + activity); it must not re-host the membership roster.

  it("does not render the members roster card", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: 600,
      canViewRoster: true,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
    expect(screen.queryByText("Current members")).not.toBeInTheDocument()
    expect(screen.getByTestId("overview-project-settings")).toBeInTheDocument()
  })
})

// ── AQU-498: member productivity detail (recent actions + files rollup) ────

describe("ProjectOverview member activity detail (AQU-498)", () => {
  // WHY: a team lead selecting a teammate should see recent actions + a
  // files-worked-on rollup (volume + timing) — and, per acceptance
  // criterion 3, ONLY when their role meets the AQU-485
  // memberProgressViewMinRole floor. The detail view is nested inside the
  // Team card's existing SectionVisibilityGate, so a below-floor caller must
  // not even see the "Activity" affordance to click.

  async function withWorkload() {
    const { getProjectAssignments } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectAssignments).mockResolvedValue([
      { userId: 1, username: "alice", openAssignments: 2, cellsTotal: 10, cellsDone: 4 },
    ])
  }

  // getProjectAssignments.mockResolvedValue persists across tests (clearAllMocks
  // clears call history, not implementation) — restore the file-wide empty
  // default so later describe blocks don't inherit this suite's workload.
  afterEach(async () => {
    const { getProjectAssignments } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectAssignments).mockResolvedValue([])
  })

  it("clicking a teammate's Activity affordance renders recent actions + files rollup", async () => {
    await withWorkload()
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    fetchMemberActivity.mockResolvedValue({
      recentEvents: [
        { id: "e1", kind: "target.cell.commit", fileId: "f1", cellId: "c1", clientTs: 1, serverTs: 1700000000000, serverSeq: 2 },
      ],
      fileRollup: [
        { fileId: "f1", fileName: "Genesis", cellsTouched: 12, wordCount: 340, lastActivityAt: 1700000000000 },
      ],
    })
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
      canViewMemberProgress: true,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }), status: "ready", refresh })
    renderOverview()

    const activityButton = await screen.findByRole("button", { name: "View activity for alice" })
    fireEvent.click(activityButton)

    const panel = await screen.findByTestId("member-activity-panel")
    expect(within(panel).getByText("Genesis")).toBeInTheDocument()
    expect(within(panel).getByText(/12 cells · 340 words/)).toBeInTheDocument()
    expect(within(panel).getByText("Edited a translation")).toBeInTheDocument()
    expect(fetchMemberActivity).toHaveBeenCalledWith("p1", "alice", "tok", expect.anything())
  })

  it("hides the Team card (and its Activity affordance) entirely for a caller below the memberProgressViewMinRole floor", async () => {
    await withWorkload()
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 700, // org raised the floor to Owner-only
      canViewMemberProgress: false,
    })
    // Project-lead (500) — below the raised floor.
    useProject.mockReturnValue({ project: projectRecord({ level: 500, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "View activity for alice" })).not.toBeInTheDocument()
    expect(screen.queryByTestId("member-activity-panel")).not.toBeInTheDocument()
  })
})

// ── AQU-538 §3.3: per-project lane table + lane filter tabs ──────────────────

describe("ProjectOverview lane table + tabs (AQU-538 §3.3)", () => {
  // WHY: once a project has more than one target-language lane, a PM must see
  // per-lane progress + people + quick actions directly on the overview, and be
  // able to filter the header StatTiles / per-file drill-down to one lane. N=1
  // projects must be byte-identical to the pre-lane overview (no table, no tabs).

  const NOW = new Date("2026-07-14T12:00:00Z").getTime()

  type PL = NonNullable<PortfolioProject["lanes"]>[number]
  const TWO_LANES: PL[] = [
    { lane: "", totalCells: 100, filledCells: 80, validatedCells: 50, lastEditAt: NOW - 2 * 3600 * 1000 },
    { lane: "es", totalCells: 100, filledCells: 20, validatedCells: 8, lastEditAt: NOW - 3 * 24 * 3600 * 1000 },
  ]

  function laneProject(over: Partial<PortfolioProject> = {}): PortfolioProject {
    return {
      id: "p1", name: "John", totalCells: 200, filledCells: 100, validatedCells: 58,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0,
      lastEditAt: NOW, deadlineAt: null, lanes: TWO_LANES, ...over,
    }
  }

  function useLaneProject(
    files: ProjectRecord["files"] =
      [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "x", cellCount: 10 }],
  ) {
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, targetLanguage: "Bambara", targetLanes: ["es"], files }),
      status: "ready", refresh,
    })
  }

  /** The StatTile whose visible label is `label` (distinct from the StatBar row
   *  which reuses the same word) — filtered by the tile-label's unique class. */
  function statTile(label: string): HTMLElement {
    const node = screen.getAllByText(label).find((n) => n.className.includes("text-[11px]"))
    return node!.parentElement as HTMLElement
  }

  beforeEach(() => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
  })

  it("renders the lane table with one row per lane and correct percentages when lanes > 1", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    const table = await screen.findByTestId("overview-lane-table")
    const defaultRow = within(table).getByTestId("overview-lane-row-default")
    const esRow = within(table).getByTestId("overview-lane-row-es")

    // Default lane labeled with the project's targetLanguage; es keeps its tag.
    expect(defaultRow).toHaveTextContent("Bambara")
    expect(esRow).toHaveTextContent("es")

    // Translated 80% / Validated 50% (default), 20% / 8% (es).
    expect(defaultRow).toHaveTextContent("80%")
    expect(defaultRow).toHaveTextContent("50%")
    expect(esRow).toHaveTextContent("20%")
    expect(esRow).toHaveTextContent("8%")
  })

  it("does not render the lane table (or tabs) for a single-lane project", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({
      lanes: [{ lane: "", totalCells: 100, filledCells: 80, validatedCells: 50, lastEditAt: NOW }],
    })])
    renderOverview()

    // The progress card still renders (Translated tile present) — just no lane UI.
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    expect(screen.queryByTestId("overview-lane-table")).not.toBeInTheDocument()
    expect(screen.queryByTestId("lane-filter-tabs")).not.toBeInTheDocument()
  })

  it("selecting a lane tab swaps the header StatTile percentages to that lane's numbers", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    await screen.findByTestId("lane-filter-tabs")

    // "All" (default) — cross-lane scalars: 100/200 = 50% translated, 58/200 = 29% validated.
    expect(statTile("Translated")).toHaveTextContent("50%")
    expect(statTile("Validated")).toHaveTextContent("29%")

    // Filter to es — laneTranslatedPct(es) = 20/100 = 20%, laneValidatedPct = 8/100 = 8%.
    fireEvent.click(screen.getByRole("tab", { name: "es" }))
    await waitFor(() => expect(statTile("Translated")).toHaveTextContent("20%"))
    expect(statTile("Validated")).toHaveTextContent("8%")

    // Back to All restores the cross-lane figures.
    fireEvent.click(screen.getByRole("tab", { name: "All" }))
    await waitFor(() => expect(statTile("Translated")).toHaveTextContent("50%"))
  })

  it("lane row ⋯ menu has Assign and Staff, not Open", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    await screen.findByTestId("overview-lane-table")
    fireEvent.click(screen.getByTestId("overview-lane-actions-es"))
    expect(screen.queryByRole("menuitem", { name: /^open$/i })).not.toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /assign/i })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /staff/i })).toBeInTheDocument()
  })

  it("Assign… from a lane row ⋯ menu mounts AssignModal pinned to that lane", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    await screen.findByTestId("overview-lane-table")
    // Closed until launched.
    expect(screen.queryByTestId("assign-modal-mock")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-lane-actions-es"))
    fireEvent.click(screen.getByRole("menuitem", { name: /assign/i }))
    const modal = await screen.findByTestId("assign-modal-mock")
    expect(modal.getAttribute("data-lane")).toBe("es")
  })

  it("Staff… on a lane row mounts StaffLanePopover for that lane", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    const table = await screen.findByTestId("overview-lane-table")
    const esStaff = within(within(table).getByTestId("overview-lane-row-es")).getByTestId("staff-lane-mock")
    expect(esStaff.getAttribute("data-lane")).toBe("es")

    const defaultStaff = within(within(table).getByTestId("overview-lane-row-default")).getByTestId("staff-lane-mock")
    expect(defaultStaff.getAttribute("data-lane")).toBe("")
    expect(defaultStaff.getAttribute("data-label")).toBe("Bambara")
  })

  it("the '+ Add language' link routes to the project settings Languages section", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    await screen.findByTestId("overview-lane-table")
    expect(screen.getByTestId("overview-lane-add-language").getAttribute("href"))
      .toBe("/project/p1/settings/general")
  })

  it("re-reads the plan with the selected lane param", async () => {
    // AQU-1092…1098: successor to the old drill-down lane test. Translated and
    // validated counts are per lane, so switching the tab must re-read the
    // plan — otherwise the board shows one language's progress under another's
    // heading.
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    renderOverview()

    await screen.findByTestId("lane-filter-tabs")
    await waitFor(() => expect(fetchProjectPlan).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("tab", { name: "es" }))

    await waitFor(() =>
      expect(fetchProjectPlan.mock.calls.some((c) => c[2] === "es")).toBe(true),
    )
  })
})

// AQU-1092…1098: the plan replaced the file breakdown as the dashboard's
// centrepiece. These cover the page-level wiring; PlanBoard.test.tsx covers
// grouping and keyboard behaviour.
describe("plan board on the overview", () => {
  const planUnit = (over: Record<string, unknown> = {}) => ({
    fileId: "f1", fileName: "Mark", fileRole: null, fileKind: null, sectionKey: "",
    totalCount: 100, filledCount: 72, validatedCount: 31,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null, updatedAt: null, updatedBy: null,
    ...over,
  })

  it("renders the plan in place of the old file breakdown", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 50, validatedCells: 10,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0,
      lastEditAt: null, deadlineAt: null, sourceLanguage: null, targetLanguage: null,
    }])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    renderOverview()

    expect(await screen.findByTestId("plan-board")).toBeInTheDocument()
    expect(await screen.findByTestId("plan-row-f1-")).toBeInTheDocument()
    // The card it replaced is gone for good.
    expect(screen.queryByTestId("file-row")).toBeNull()
    expect(screen.queryByTestId("file-breakdown-header")).toBeNull()
  })

  it("summarises how many units are done without naming the unit", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 50, validatedCells: 10,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0,
      lastEditAt: null, deadlineAt: null, sourceLanguage: null, targetLanguage: null,
    }])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1,
      units: [planUnit({ doneAt: 1, doneBy: "randall" }), planUnit({ fileId: "f2", fileName: "Luke" })],
    })
    renderOverview()

    const summary = await screen.findByTestId("plan-summary")
    expect(summary).toHaveTextContent("1 of 2 done")
    expect(summary.textContent).not.toMatch(/book/i)
  })

  it("docks the inspector beside the board on a wide screen", async () => {
    // Docked means it takes real width and the board reflows — not an overlay.
    // AppShell renders `aside` inline; the Sheet path is the narrow fallback.
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 50, validatedCells: 10,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0,
      lastEditAt: null, deadlineAt: null, sourceLanguage: null, targetLanguage: null,
    }])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    renderOverview()

    fireEvent.click(await screen.findByTestId("plan-row-f1-"))
    const inspector = await screen.findByTestId("plan-inspector")
    expect(inspector).toBeInTheDocument()
    // Not inside a dialog: the page stays interactive behind it.
    expect(inspector.closest('[role="dialog"]')).toBeNull()
  })

  it("withholds the planning controls from someone below maintainer", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400 }), status: "ready", refresh, roleLevel: 400,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 50, validatedCells: 10,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0,
      lastEditAt: null, deadlineAt: null, sourceLanguage: null, targetLanguage: null,
    }])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1,
      units: [planUnit({ targetDate: "2026-11-01" })],
    })
    renderOverview()

    fireEvent.click(await screen.findByTestId("plan-row-f1-"))
    await screen.findByTestId("plan-inspector")
    expect(screen.queryByTestId("plan-mark-done")).toBeNull()
    // Formatted the way the project deadline above it is formatted, not raw ISO.
    expect(screen.getByTestId("plan-target-readonly")).toHaveTextContent("November 1")
  })

  it("shows an empty state when nothing is plannable yet", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 0, filledCells: 0, validatedCells: 0,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0,
      lastEditAt: null, deadlineAt: null, sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()
    expect(await screen.findByTestId("plan-empty")).toBeInTheDocument()
  })
})

// AQU-656: original-blob downloads. The files card they used to hang off was
// replaced by the plan (AQU-1092); the gallery is now a compact assets card
// that lists only files with a stored original.
describe("imported originals on the overview (AQU-656)", () => {
  beforeEach(() => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [],
    })
  })

  function fileWith(
    fileId: string,
    name: string,
    hasOriginalSource = false,
  ): import("@/lib/sync/cells-read").FileSummary {
    return {
      fileId, projectId: "p1", name, fileType: "usfm",
      sourceLanguage: null, targetLanguage: null,
      cellCount: 10, filledCount: 5, approvedCount: 2, wordCount: 100,
      lastEditAt: null, hasOriginalSource,
    }
  }

  function useFiles(files: import("@/lib/sync/cells-read").FileSummary[]) {
    fetchProjectFiles.mockResolvedValue(files)
    useProject.mockReturnValue({
      project: projectRecord({
        level: 400,
        name: "My Project",
        files: files.map((f) => ({
          id: f.fileId, name: f.name, type: "usfm", createdAt: "x", cellCount: f.cellCount,
        })),
      }),
      status: "ready",
      refresh,
    })
  }

  it("shows Download all originals and per-file download when a blob exists", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles([
      fileWith("f1", "Genesis.usfm", true),
      fileWith("f2", "Notes.md"),
    ])

    renderOverview()

    expect(await screen.findByTestId("imported-originals")).toBeInTheDocument()
    expect(screen.getByTestId("download-originals-zip")).toHaveTextContent("Download all originals")
    const original = screen.getByTestId("download-original-file")
    expect(original.tagName).toBe("BUTTON")
    expect(original).toHaveAttribute("aria-label", "Download original Genesis.usfm")
    expect(screen.queryByRole("button", { name: "Download original Notes.md" })).not.toBeInTheDocument()
    expect(screen.getByText("Genesis.usfm")).toBeInTheDocument()
    expect(screen.queryByText("Notes.md")).not.toBeInTheDocument()
  })

  it("hides original-download controls when no file has a stored original", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles([fileWith("f1", "Genesis.usfm")])

    renderOverview()

    await screen.findByTestId("plan-board")
    expect(screen.queryByTestId("imported-originals")).not.toBeInTheDocument()
    expect(screen.queryByTestId("download-originals-zip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("download-original-file")).not.toBeInTheDocument()
  })

  it("hides original-download controls when the caller is below the org's export floor", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: false })
    useFiles([fileWith("f1", "Genesis.usfm", true)])

    renderOverview()

    await screen.findByTestId("plan-board")
    expect(screen.queryByTestId("imported-originals")).not.toBeInTheDocument()
    expect(screen.queryByTestId("download-originals-zip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("download-original-file")).not.toBeInTheDocument()
  })
})
