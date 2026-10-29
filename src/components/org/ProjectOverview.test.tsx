import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react"
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectOverview, deriveProjectStatus } from "./ProjectOverview"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { fmtDeadlineDate } from "@/lib/format-date"
import { PROGRESS_BG } from "@/lib/progress/progress-palette"
import { resetWindowFocusRevalidateForTests } from "@/lib/sync/window-focus-revalidate"

// Keep the overview suite's project-member reads local.
vi.mock("@/lib/frontier/members", async (importActual) => ({
  ...await importActual<typeof import("@/lib/frontier/members")>(),
  fetchProjectRoster: vi.fn(async () => ({ kind: "ok", members: [] })),
}))

const mondayLink = vi.fn(async (..._args: unknown[]) => ({ linked: false, orgConnected: false }))
vi.mock("@/lib/monday/api", () => ({
  fetchMondayLink: (...args: unknown[]) => mondayLink(...args),
  fetchMondayBoardStructure: vi.fn(),
}))

const navigate = vi.fn()
// AQU-2105: the LangQuest badge reads the project's link on open; unlinked here.
vi.mock("@/lib/langquest/api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/langquest/api")>()),
  fetchLangQuestLink: vi.fn().mockResolvedValue(null),
}))
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

const toastAdd = vi.fn()
vi.mock("@/components/ui/toast", async (importActual) => ({
  ...await importActual<typeof import("@/components/ui/toast")>(),
  toast: { add: (...a: unknown[]) => toastAdd(...a), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}))

const useProject = vi.fn()
const refresh = vi.fn()
// AQU-1771: the overview waits for the project's settings before it trusts the
// visibility floors. A test that does not hand one in gets a loaded response
// that carries no org policy (the org-settings mock decides), read-only.
const LOADED_PROJECT_SETTINGS = {
  hasFetched: true,
  canEdit: false,
  settings: {},
  orgPolicy: null,
  visibilityFloors: null,
  patch: vi.fn(async () => ({ kind: "ok" as const })),
  refresh: vi.fn(async () => null),
}
vi.mock("@/hooks/useProject", () => ({
  useProject: (...a: unknown[]) => {
    const result = useProject(...a) as Record<string, unknown> | undefined
    return result && !("projectSettings" in result)
      ? { ...result, projectSettings: LOADED_PROJECT_SETTINGS }
      : result
  },
}))

// AQU-1277: the PM picker calls useProjectMembers, which fetches
// /api/v2/projects/:id/members. Unmocked that reached production identity for
// real. The overview Members card (AQU-1171) mounts the same hook via
// MembersSection once expanded; an empty roster is enough to prove the
// surface is present without hitting identity.
const pmMembers: { members: unknown[] } = { members: [] }
vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: pmMembers.members,
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(async () => {}),
    add: vi.fn(async () => null),
    addMany: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
    changeRole: vi.fn(async () => null),
  }),
}))

const archiveProjectRemote = vi.fn()
const unarchiveProjectRemote = vi.fn()
vi.mock("@/lib/sync/archive", () => ({
  archiveProjectRemote: (...a: unknown[]) => archiveProjectRemote(...a),
  unarchiveProjectRemote: (...a: unknown[]) => unarchiveProjectRemote(...a),
}))

// Project Download UI (Phase 5) — off (browser SPA behavior) by default;
// the "ProjectOverview offline" describe block below flips these on.
let tauriRuntime = false
vi.mock("@/lib/offline/is-tauri", () => ({
  isTauriRuntime: () => tauriRuntime,
}))
const fakeOfflineStore = { id: "fake-offline-store" }
let offlineStoreValue: { store: unknown; loading: boolean; error: Error | null } = {
  store: null,
  loading: false,
  error: null,
}
vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => offlineStoreValue,
}))
const downloadProjectOffline = vi.fn()
const removeOfflineProject = vi.fn((..._a: unknown[]) => ({ ok: true }))
const getOfflineQueueDepth = vi.fn((..._a: unknown[]) => 0)
let offlineProjectStatus: { projectId: string; status: string } | null = null
let downloadProgressValue: { filesDone: number; filesTotal: number } | null = null
vi.mock("@/lib/offline/download", () => ({
  downloadProjectOffline: (...a: unknown[]) => downloadProjectOffline(...a),
  removeOfflineProject: (...a: unknown[]) => removeOfflineProject(...a),
  getOfflineQueueDepth: (...a: unknown[]) => getOfflineQueueDepth(...a),
  useOfflineProjectStatus: () => offlineProjectStatus,
  useDownloadProgress: () => downloadProgressValue,
}))

type PortfolioProject = import("@/lib/frontier/portfolio").PortfolioProject

// deadlineStatus stub — we control it per test via module-level variable
let _deadlineStatusResult: "overdue" | "soon" | "ok" | null = null
const getPortfolio = vi.fn((_jwt: string, _orgId: number): Promise<PortfolioProject[]> => Promise.resolve([]))
vi.mock("@/lib/frontier/portfolio", async (importActual) => ({
  // Media redesign slice 1: the real language-by-language measures
  // (portfolioMeasure, laneStartedPct, …), which the stubs below never touch.
  ...(await importActual<typeof import("@/lib/frontier/portfolio")>()),
  getPortfolio: (jwt: string, orgId: number) => getPortfolio(jwt, orgId),
  // Real implementations — tests must not override these with wrong stubs
  // AQU-1566: audio is measured against the server's audio total (a dubbing
  // file's cue sheet), falling back to totalCells for an older server.
  audioDenominator: (p: { audioTotalCells?: number; totalCells: number }) => p.audioTotalCells ?? p.totalCells,
  audioPct: (p: { audioCells: number; audioTotalCells?: number; totalCells: number }) => {
    const total = p.audioTotalCells ?? p.totalCells
    return total > 0 ? p.audioCells / total : 0
  },
  // AQU-1093: denominator is the whole file, so the tile agrees with the plan
  // board's bars. The of-recorded ratio moved to the tooltip.
  audioValidatedPct: (p: { validatedAudioCells: number; audioTotalCells?: number; totalCells: number }) => {
    const total = p.audioTotalCells ?? p.totalCells
    return total > 0 ? Math.min(1, p.validatedAudioCells / total) : 0
  },
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
  // AQU-2116: real implementation, not a stub — the Progress card's whole text
  // half hangs off this rule, so a wrong stub here would hide it.
  isAudioOnlyView: (
    p: { filledCells: number; audioCells: number; lanes?: Array<{ filledCells: number; role?: string }> },
    lane: { filledCells: number; audioCells?: number } | null,
  ) => {
    if (lane != null) {
      if (lane.audioCells == null) return false
      return lane.filledCells === 0 && lane.audioCells > 0
    }
    const textAnywhere =
      p.filledCells > 0 || (p.lanes ?? []).some((l) => l.role !== "source" && l.filledCells > 0)
    return !textAnywhere && p.audioCells > 0
  },
  // AQU-538 §3.3: real per-lane helpers so the lane table/tiles compute true %s.
  laneTranslatedPct: (l: { filledCells: number; totalCells: number }) => (l.totalCells > 0 ? l.filledCells / l.totalCells : 0),
  laneValidatedPct: (l: { validatedCells: number; totalCells: number }) => (l.totalCells > 0 ? l.validatedCells / l.totalCells : 0),
}))

// AQU-538 §3.3: the lane table mounts AssignModal + StaffLanePopover per lane.
// Stub both to capture the lane they were handed (defaultLane / lane) without
// pulling their whole fetch surface into this suite.
vi.mock("@/components/AssignModal", () => ({
  AssignModal: ({ open, defaultLane, projectFiles }: {
    open: boolean
    defaultLane?: string
    projectFiles?: Array<{ id: string }>
  }) =>
    open ? (
      <div
        data-testid="assign-modal-mock"
        data-lane={defaultLane ?? ""}
        data-files={(projectFiles ?? []).map((f) => f.id).join(",")}
      />
    ) : null,
}))
vi.mock("@/components/StaffLanePopover", () => ({
  // `open` is surfaced because the lane table drives it from two places now
  // (the ⋯ menu's Staff… and, since AQU-1998, the People cell itself).
  StaffLanePopover: ({ lane, laneLabel, open }: { lane: string; laneLabel: string; open?: boolean }) => (
    <div
      data-testid="staff-lane-mock"
      data-lane={lane}
      data-label={laneLabel}
      data-open={String(open ?? false)}
    />
  ),
}))
// AQU-1914: the plan's Assign reads the caller's own lane-delegate grant.
const fetchMyScopeGrant = vi.fn(async (..._a: unknown[]): Promise<unknown> => null)
vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopes: vi.fn(async () => []),
  putMemberScopes: vi.fn(async () => ({ scopes: [], laneNames: {} })),
  // AQU-1994: `null` is "the server did not say", which leaves every Assign
  // surface offering the project's own lanes exactly as it did before.
  fetchProjectLaneStaffing: vi.fn(async () => null),
  fetchMyScopeGrant: (...a: unknown[]) => fetchMyScopeGrant(...a),
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
  // download.ts (Phase 5, imported transitively by ProjectOverview.tsx) reads
  // this export at module scope for its default deps — never actually
  // invoked by these tests, which don't exercise the offline download flow.
  streamFileCells: vi.fn(),
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
  // AQU-1969: the Team card's read — the translate roster plus validate assignments.
  getProjectTeamProgress: vi.fn(async () => ({ roster: [], validations: [] })),
  getMyAssignments: vi.fn(async () => []),
  unassignAssignment: vi.fn(async () => {}),
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
  canEgress: false,
  egressMinRole: 700,
  canViewRoster: true,
  rosterViewMinRole: 600,
  canViewMemberProgress: true,
  memberProgressViewMinRole: 600,
  // AQU-496: default leads-only (matches the server's safe default).
  allowSelfAssignment: false,
  allowScopedLaneAssignment: false,
  countStructuralCells: true,
  autoPropagateRepetitions: true,
  countStructuralOverrides: 0,
  resetCountStructuralOverrides: vi.fn(),
  validationCountDefault: null,
  validationCountAudioDefault: null,
  validationCountOverrides: 0,
  validationCountAudioOverrides: 0,
  overrideProjects: { countStructuralCells: null, validationCount: null, validationCountAudio: null },
  resetValidationCountOverrides: vi.fn(),
  mediaDefaults: {},
  mediaDefaultOverrides: {},
  mediaOverrideProjects: {},
  resetMediaDefaultOverrides: vi.fn(),
  // AQU-1037: assignment authority defaults to project_lead.
  assignmentMinRole: 500,
  // AQU-822: default termbase-edit floor (project_lead), as the server resolves it.
  termbaseEditMinRole: 500,
  languageEditMinRole: 600,
  commentCreateMinRole: 200,
  commentResolveMinRole: 400,
  refresh: vi.fn(async () => null),
  patch: vi.fn(async () => ({ kind: "ok" as const, value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })),
  requestPromotion: vi.fn(async () => ({ kind: "blocked" as const })),
})
const useOrgSettingsMock = vi.fn<() => OrgSettingsMock>(defaultOrgSettingsMock)
const canEditRosterProgressFloorMock = vi.fn((level: number | null | undefined) => (level ?? 0) >= 700)
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: (...args: unknown[]) => (useOrgSettingsMock as (...a: unknown[]) => OrgSettingsMock)(...args),
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

/**
 * AQU-1771: the project-settings instance useProject hands the overview —
 * the org policy carried for this project and the floors it enforces. The
 * Team / Members badges write THIS project's own values through its `patch`.
 */
function projectSettingsMock({
  rosterOrg = ROLE.MAINTAINER,
  rosterOwn = null,
  progressOrg = ROLE.MAINTAINER,
  progressOwn = null,
  canEdit = true,
}: {
  rosterOrg?: number
  rosterOwn?: number | null
  progressOrg?: number
  progressOwn?: number | null
  canEdit?: boolean
} = {}) {
  const view = (org: number, own: number | null) => {
    const project = own != null && own > org ? own : null
    return { org, project, effective: project ?? org }
  }
  return {
    hasFetched: true,
    canEdit,
    settings: {
      ...(rosterOwn != null ? { rosterViewMinRole: rosterOwn } : {}),
      ...(progressOwn != null ? { memberProgressViewMinRole: progressOwn } : {}),
    },
    patch: vi.fn(async () => ({ kind: "ok" as const })),
    orgPolicy: {
      rosterViewMinRole: rosterOrg,
      memberProgressViewMinRole: progressOrg,
      allowSelfAssignment: false,
      allowScopedLaneAssignment: false,
      assignmentMinRole: ROLE.PROJECT_LEAD,
      autoPropagateRepetitions: true,
      exportMinRole: null,
    },
    visibilityFloors: {
      rosterViewMinRole: view(rosterOrg, rosterOwn),
      memberProgressViewMinRole: view(progressOrg, progressOwn),
    },
  }
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

function overviewTree() {
  return (
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <OrgProvider>
        <Routes>
          <Route path="/projects/:id" element={<ProjectOverview />} />
          <Route path="/project/:id/settings" element={<SettingsLocationProbe />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>
  )
}

function renderOverview() {
  return render(overviewTree())
}

beforeEach(async () => {
  mondayLink.mockResolvedValue({ linked: false, orgConnected: false })
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
  // No lane-delegate grant unless a test gives one (AQU-1914).
  fetchMyScopeGrant.mockResolvedValue(null)
  canEditRosterProgressFloorMock.mockImplementation((level: number | null | undefined) => (level ?? 0) >= 700)
  tauriRuntime = false
  offlineStoreValue = { store: null, loading: false, error: null }
  offlineProjectStatus = null
  downloadProgressValue = null
  removeOfflineProject.mockReturnValue({ ok: true })
  getOfflineQueueDepth.mockReturnValue(0)
})
afterEach(() => vi.clearAllMocks())

/** Build a FileSummary stub for testing the file list. */
function fileSummary(i: number): import("@/lib/sync/cells-read").FileSummary {
  return { fileId: `f${i}`, projectId: "p1", name: `File${i}.usfm`, fileType: "usfm", declaredSourceLanguage: null, declaredTargetLanguage: null, cellCount: 10, filledCount: 5, approvedCount: 2, wordCount: 100, lastEditAt: null }
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

  it("AQU-1954: a project that records audio shows its audio at 0% before the first take", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 80, validatedCells: 50,
      aiDraftedCells: 0,
      audioTotalCells: 100, recordsAudio: true,
      audioCells: 0,
      validatedAudioCells: 0,
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    await waitFor(() => expect(screen.getAllByText("Has audio").length).toBeGreaterThan(0))
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
    // AQU-2116: and the text figures are GONE. The card used to read
    // "Translated 0% · Validated 0%" beside these real audio numbers, because
    // the text tiles only ever asked whether the project had cells at all; a PM
    // read those zeroes as "the verifications never registered".
    const card = screen.getByTestId("progress-card")
    expect(within(card).queryByText("Translated")).not.toBeInTheDocument()
    expect(within(card).queryByText("Validated")).not.toBeInTheDocument()
    expect(within(card).queryByTestId("stat-bar-textTranslated")).not.toBeInTheDocument()
    expect(within(card).queryByTestId("stat-bar-textValidated")).not.toBeInTheDocument()
    // AQU-1092: the tile used to render a hardcoded "N/A" because the metric
    // was said not to exist. It does (cell_audio.approved, counted by the org
    // portfolio), so the tile shows a real number.
    // AQU-1093: that number is 15 of 100 CELLS = 15%, not 15 of 60 takes = 25%
    // — the tile and the plan board's audio bar must report the same share.
    // AQU-1764 gave the measure a bar of its own, so the tile and its bar
    // both say it.
    expect(screen.getAllByText("Audio Validated")).toHaveLength(2)
    expect(screen.getAllByText("15%")).toHaveLength(2)
    expect(screen.queryByText("N/A")).not.toBeInTheDocument()

    // While they are hidden the Customize menu does not offer them either.
    fireEvent.click(screen.getByTestId("customize-stats-trigger"))
    await screen.findByTestId("customize-stat-audio-validated")
    expect(screen.queryByTestId("customize-stat-translated")).not.toBeInTheDocument()
    expect(screen.queryByTestId("customize-stat-validated")).not.toBeInTheDocument()
  })

  it("AQU-2116: one target cell of text brings Translated/Validated back", async () => {
    // Evidence both ways: the work became text work, so the text figures are
    // owed again — and the Audio Validated figure must not budge.
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100,
      filledCells: 1, // somebody wrote one target cell
      validatedCells: 0, aiDraftedCells: 0,
      audioCells: 60, validatedAudioCells: 15,
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    const card = await screen.findByTestId("progress-card")
    await waitFor(() => expect(within(card).getAllByText("Translated").length).toBeGreaterThan(0))
    expect(within(card).getAllByText("Validated").length).toBeGreaterThan(0)
    expect(within(card).getByTestId("stat-bar-textTranslated")).toHaveTextContent("1/100 cells")
    // Unchanged by this fix: 15 of 100 cells.
    expect(within(card).getByTestId("stat-bar-audioValidated")).toHaveTextContent("15/100 cells")
  })

  it("AQU-2116: a language that records audio but has recorded nothing still shows its text figures", async () => {
    // Absence of text is not evidence on its own — a text project on day one
    // has none either. Only recordings with no text read as audio-only.
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 0, validatedCells: 0,
      aiDraftedCells: 0,
      audioTotalCells: 100, recordsAudio: true,
      audioCells: 0, validatedAudioCells: 0,
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    const card = await screen.findByTestId("progress-card")
    await waitFor(() => expect(within(card).getAllByText("Translated").length).toBeGreaterThan(0))
    expect(within(card).getAllByText("Validated").length).toBeGreaterThan(0)
  })

  // Media redesign slice 1 (P1.4): a language that delivers Audio has no text
  // to translate, so its project shows no Translated or Validated tile at 0%.
  it("an Audio language's project shows its recordings and no text tiles", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "RUT", type: "usfm", createdAt: "x", cellCount: 45 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "Audio Bible", totalCells: 45,
      filledCells: 0, validatedCells: 0, aiDraftedCells: 0,
      audioTotalCells: 45, audioCells: 17, validatedAudioCells: 9, recordsAudio: true,
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
      lanes: [{
        lane: "sw", role: "target", name: "Swahili", laneId: "ln-sw", position: 1,
        totalCells: 45, filledCells: 0, validatedCells: 0, lastEditAt: null,
        audioCells: 17, validatedAudioCells: 9, audioTotalCells: 45, recordsAudio: true,
        delivers: "audio", bothValidatedCells: 0,
      }],
    }])
    renderOverview()

    await waitFor(() => expect(screen.getAllByText("Has audio").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Audio Validated").length).toBeGreaterThan(0)
    // 9 of 45 lines approved: 20%. 17 of 45 recorded: 38%.
    expect(screen.getAllByText("20%").length).toBeGreaterThan(0)
    expect(screen.getAllByText("38%").length).toBeGreaterThan(0)
    expect(screen.queryByText("Translated")).not.toBeInTheDocument()
    expect(screen.queryByText("Validated")).not.toBeInTheDocument()
  })

  // Sam, Oct 22: on "All", a Text language beside an Audio one reads its
  // validated text over its own lines, as Translated does; the Audio
  // language's approvals read only in the audio tiles.
  it("counts only the text languages in the All tab's Validated, beside an Audio language", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "RUT", type: "usfm", createdAt: "x", cellCount: 45 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "Audio Bible", totalCells: 90,
      filledCells: 30, validatedCells: 20, aiDraftedCells: 0,
      audioTotalCells: 90, audioCells: 15, validatedAudioCells: 6, recordsAudio: true,
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
      lanes: [{
        lane: "fr", role: "target", name: "French", laneId: "ln-fr", position: 1,
        totalCells: 45, filledCells: 30, validatedCells: 20, lastEditAt: null,
        audioCells: 5, validatedAudioCells: 0, audioTotalCells: 45, recordsAudio: false,
        delivers: "text", bothValidatedCells: 0,
      }, {
        lane: "sw", role: "target", name: "Swahili", laneId: "ln-sw", position: 2,
        totalCells: 45, filledCells: 0, validatedCells: 0, lastEditAt: null,
        audioCells: 10, validatedAudioCells: 6, audioTotalCells: 45, recordsAudio: true,
        delivers: "audio", bothValidatedCells: 0,
      }],
    }])
    renderOverview()

    await waitFor(() => expect(screen.getAllByText("Validated").length).toBeGreaterThan(0))
    // 20 of 45: 44%. The old mix, 26 of 90, would read 29%.
    expect(screen.getAllByText("44%").length).toBeGreaterThan(0)
    expect(screen.queryByText("29%")).not.toBeInTheDocument()
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

  // AQU-2097. WHY: the server refuses an archived project's reads, and the
  // cards they feed hide on that refusal. Restore re-read only the project, so
  // Progress, Languages and Team stayed gone, and the plan lost its language,
  // until a manual reload.
  it("Restore re-reads what the archive hid, without a reload (AQU-2097)", async () => {
    const live = projectRecord({ level: 700 })
    useProject.mockReturnValue({ project: projectRecord({ level: 700, deletedAt: "2026-05-01" }), status: "ready", refresh })
    refresh.mockImplementation(async () => {
      useProject.mockReturnValue({ project: live, status: "ready", refresh })
    })
    unarchiveProjectRemote.mockResolvedValue({ kind: "restored" })
    renderOverview()
    await screen.findByTestId("overview-archived-notice")
    const portfolioReads = getPortfolio.mock.calls.length

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))

    await waitFor(() => expect(screen.queryByTestId("overview-archived-notice")).toBeNull())
    expect(LOADED_PROJECT_SETTINGS.refresh).toHaveBeenCalled()
    await waitFor(() => expect(getPortfolio.mock.calls.length).toBeGreaterThan(portfolioReads))
  })

  // AQU-2088: the server refuses every per-project read for an archived
  // project, so the plan had nothing to draw and sat on "Loading the plan…"
  // for ever. The overview says it is archived instead.
  it("an archived project says so in the plan's place, and never draws the board", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, deletedAt: "2026-05-01" }),
      status: "ready",
      refresh,
    })
    renderOverview()

    const notice = await screen.findByTestId("overview-archived-notice")
    expect(notice).toHaveTextContent(/this project is archived/i)
    expect(notice).toHaveTextContent(/choose Restore above/i)
    expect(screen.queryByTestId("plan-loading")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plan-error")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plan-empty")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-team-card")).not.toBeInTheDocument()
    // The read is refused anyway; don't spend the round trip to be told.
    expect(fetchProjectPlan).not.toHaveBeenCalled()
  })

  it("tells a reader who cannot restore who can, instead of pointing at a button they lack", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, deletedAt: "2026-05-01" }),
      status: "ready",
      refresh,
    })
    renderOverview()

    const notice = await screen.findByTestId("overview-archived-notice")
    expect(notice).toHaveTextContent(/a maintainer can restore it/i)
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument()
  })

  it("an active project still draws the plan and no archived notice", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    await waitFor(() => expect(fetchProjectPlan).toHaveBeenCalled())
    expect(screen.queryByTestId("overview-archived-notice")).not.toBeInTheDocument()
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

describe("ProjectOverview offline (Tauri desktop, Phase 5)", () => {
  beforeEach(() => {
    tauriRuntime = true
    offlineStoreValue = { store: fakeOfflineStore, loading: false, error: null }
  })

  it("shows Make available offline even for a viewer with no other overflow permissions", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 100 }), status: "ready", refresh })
    renderOverview()

    fireEvent.click(await screen.findByRole("button", { name: "More actions" }))
    const item = await screen.findByRole("menuitem", { name: "Make available offline" })
    fireEvent.click(item)

    await waitFor(() => expect(downloadProjectOffline).toHaveBeenCalledWith(fakeOfflineStore, "p1", "jwt"))
  })

  it("shows the offline badge and Remove offline copy once ready", async () => {
    offlineProjectStatus = { projectId: "p1", status: "ready" }
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    expect(await screen.findByText("Available offline")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    const item = await screen.findByRole("menuitem", { name: "Remove offline copy" })
    fireEvent.click(item)

    expect(removeOfflineProject).toHaveBeenCalledWith(fakeOfflineStore, "p1")
  })

  it("shows a downloading badge with file progress while a download is in flight", async () => {
    offlineProjectStatus = { projectId: "p1", status: "downloading" }
    downloadProgressValue = { filesDone: 1, filesTotal: 4 }
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    expect(await screen.findByText("Downloading… (1/4 files)")).toBeInTheDocument()
  })

  it("blocks Remove offline copy and surfaces an error when writes are still queued", async () => {
    offlineProjectStatus = { projectId: "p1", status: "ready" }
    getOfflineQueueDepth.mockReturnValue(2)
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    fireEvent.click(await screen.findByRole("button", { name: "More actions" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove offline copy" }))

    expect(removeOfflineProject).not.toHaveBeenCalled()
    expect(await screen.findByText(/haven't synced to the server/)).toBeInTheDocument()
  })

  it("does not show offline actions outside Tauri", async () => {
    tauriRuntime = false
    useProject.mockReturnValue({ project: projectRecord({ level: 100 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument()
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

    // AQU-1950: the note sits behind a circled-i beside the heading, shut
    // until it is clicked.
    const pmInfo = screen.getByRole("button", { name: "What naming a project manager does" })
    expect(pmInfo).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByTestId("overview-pm-lead-note")).toHaveAttribute("data-state", "closed")
    expect(screen.getByTestId("overview-pm-lead-note")).toHaveAttribute("aria-hidden", "true")
    fireEvent.click(pmInfo)
    expect(pmInfo).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("overview-pm-lead-note")).toHaveAttribute("data-state", "open")
    expect(screen.getByTestId("overview-pm-lead-note")).toHaveTextContent(
      /adds them as a Project lead/,
    )
    expect(screen.getByTestId("overview-pm-lead-note")).toHaveTextContent(
      /does not remove that membership/,
    )

    fireEvent.click(screen.getByRole("button", { name: "Change project manager" }))
    expect(screen.getByRole("heading", { name: "Change project manager" })).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveTextContent(/adds them as a Project lead/)
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))

    await waitFor(() => expect(setProjectPm).toHaveBeenCalledWith("jwt", "p1", null))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    await waitFor(() =>
      expect(fetchAccessibleProjects.mock.calls.length).toBeGreaterThan(callsBeforeSave),
    )
  })

  // AQU-2260 (Sam, Oct 29, option 2B): one candidate per member, so the
  // project manager list gets a search box.
  it("the project manager list has a search box that narrows it", async () => {
    pmMembers.members = [
      { userId: 7, username: "wendi", role: { level: 500, name: "project_lead", source: "override" }, secondarySources: [] },
      { userId: 8, username: "tomas", role: { level: 400, name: "contributor", source: "override" }, secondarySources: [] },
    ]
    useProject.mockReturnValue({
      project: projectRecord({ level: 600 }),
      status: "ready",
      refresh,
      pm: { id: 7, username: "wendi" },
    })
    renderOverview()
    fireEvent.click(await screen.findByRole("button", { name: "Change project manager" }))
    fireEvent.click(await screen.findByRole("combobox", { name: "Project manager" }))
    const search = await screen.findByRole("combobox", { name: "Search the list" })
    fireEvent.change(search, { target: { value: "tom" } })
    expect(await screen.findByRole("option", { name: /tomas/ })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /wendi/ })).toBeNull()
    pmMembers.members = []
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

  // AQU-1771: the project's org, not the switcher's. Org 1 is active (default
  // mock), the project lives in org 99: its portfolio and its settings are 99's.
  it("reads the PROJECT's org even when another org is active", async () => {
    const orgIds: Array<number | null | undefined> = []
    useOrgSettingsMock.mockImplementation((...args: unknown[]) => {
      orgIds.push(args[0] as number | null | undefined)
      return defaultOrgSettingsMock()
    })
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, orgId: 99, files: [] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([])

    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    await waitFor(() => expect(getPortfolio).toHaveBeenCalledWith("jwt", 99))
    expect(getPortfolio).not.toHaveBeenCalledWith("jwt", 1)
    // (The sidebar reads the ACTIVE org's settings for its own nav, so org 1
    // may appear among all calls; the overview's own read is org 99's.)
    expect(orgIds).toContain(99)
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

// ── AQU-1764: the shared progress palette on the Progress card ─────────────

describe("ProjectOverview Progress card colours (AQU-1764)", () => {
  // Sam, 2026-10-13 ("Layout A, softest"): one single-colour bar per measure,
  // each in its measure's tone from the shared palette, and Audio validated
  // gets the bar it never had. The tiles' numbers lose their four colours;
  // the colour moves to a swatch before each label.
  it("draws one bar per measure in its own tone, Audio validated included, and a matching swatch on each tile", async () => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue([])
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 100, filledCells: 80, validatedCells: 50,
      aiDraftedCells: 10, audioCells: 60, validatedAudioCells: 15,
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
      sourceLanguage: null, targetLanguage: null,
    }])
    renderOverview()

    const card = await screen.findByTestId("progress-card")
    await waitFor(() => expect(within(card).getAllByTestId(/^stat-bar-/)).toHaveLength(5))
    const bars = within(card).getAllByTestId(/^stat-bar-/).map((row) => {
      const fill = row.querySelector<HTMLElement>("[style]")!
      return [row.getAttribute("data-testid"), fill.style.width, fill.className.includes(
        PROGRESS_BG[row.getAttribute("data-testid")!.slice("stat-bar-".length) as keyof typeof PROGRESS_BG],
      )]
    })
    expect(bars).toEqual([
      ["stat-bar-textTranslated", "80%", true],
      ["stat-bar-textAi", "10%", true],
      ["stat-bar-textValidated", "50%", true],
      ["stat-bar-audioRecorded", "60%", true],
      ["stat-bar-audioValidated", "15%", true],
    ])
    expect(within(card).getByTestId("stat-bar-audioValidated")).toHaveTextContent("Audio Validated15%15/100 cells")

    const swatches = [...card.querySelectorAll<HTMLElement>("[data-progress-swatch]")]
    expect(swatches.map((s) => s.dataset.progressSwatch)).toEqual([
      "textTranslated", "textAi", "textValidated", "audioRecorded", "audioValidated",
    ])
    // Each tile's number is in the text colour, not a colour of its own.
    for (const swatch of swatches) {
      const number = swatch.closest("p")!.previousElementSibling!
      expect(number.className).toContain("text-foreground")
      expect(number.className).not.toMatch(/amber|violet|emerald|sky/)
    }
  })
})

// ── AQU-486: per-section visibility chrome ──────────────────────────────────

describe("ProjectOverview Members card (AQU-1171)", () => {
  // WHY: managers need the settings roster (add / change-role / revoke) one
  // click from the overview, without the card making the page long. It starts
  // collapsed on every mount, sits directly under the Team card, and keeps
  // the original gates: manager, not archived, and the roster-visibility floor.

  function teamCard(): HTMLElement {
    return screen.getByTestId("overview-team-card")
  }

  it("starts collapsed under the Team card and reveals the settings roster when opened", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: 600,
      canViewRoster: true,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    const card = await screen.findByTestId("overview-members-card")
    expect(card).toHaveAttribute("data-expanded", "false")
    expect(teamCard().nextElementSibling).toBe(card)
    expect(within(card).getByRole("heading", { name: "Members" })).toBeInTheDocument()
    expect(within(card).getByTestId("section-visibility-badge")).toHaveTextContent(/maintainers & owners/i)
    expect(screen.queryByTestId("settings-members-section")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add a member" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-members-toggle"))

    expect(card).toHaveAttribute("data-expanded", "true")
    expect(screen.getByTestId("settings-members-section")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add a member" })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-members-toggle"))

    expect(card).toHaveAttribute("data-expanded", "false")
    expect(screen.queryByTestId("settings-members-section")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add a member" })).not.toBeInTheDocument()
  })

  it("starts collapsed again after a fresh mount, with no saved open state", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    const view = renderOverview()

    fireEvent.click(await screen.findByTestId("overview-members-toggle"))
    expect(screen.getByTestId("settings-members-section")).toBeInTheDocument()

    view.unmount()
    renderOverview()

    const card = await screen.findByTestId("overview-members-card")
    expect(card).toHaveAttribute("data-expanded", "false")
    expect(screen.queryByTestId("settings-members-section")).not.toBeInTheDocument()
  })

  it("hides the Team card as well when the roster floor is owner-only", async () => {
    // The Team card lists the same people. Leaving it open for a maintainer,
    // under "Only maintainers & owners can see this", is the roster floor
    // appearing not to stick.
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: ROLE.OWNER,
      canViewRoster: false,
      memberProgressViewMinRole: ROLE.MAINTAINER,
      canViewMemberProgress: true,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: ROLE.MAINTAINER }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Team" })).not.toBeInTheDocument()
    expect(screen.queryByText(/maintainers & owners/i)).not.toBeInTheDocument()
  })

  it("hides the card entirely when the roster floor is above the caller's role", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: 700,
      canViewRoster: false,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Members" })).not.toBeInTheDocument()
  })

  it("hides the card from a caller who cannot manage the project", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: ROLE.VIEWER,
      canViewRoster: true,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: ROLE.CONTRIBUTOR }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
  })

  it("hides the card on an archived project", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, deletedAt: "2026-08-01T00:00:00.000Z" }),
      status: "ready",
      refresh,
    })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
  })

  // AQU-1771: the badge writes THIS project's own member-list floor, which can
  // only be stricter than the org's. Choosing the org's setting follows the org.
  function choose(option: HTMLElement) {
    fireEvent.pointerMove(option)
    fireEvent.mouseMove(option)
    fireEvent.keyDown(option, { key: "Enter" })
  }

  async function openMembersPicker(settings: ReturnType<typeof projectSettingsMock>) {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.MAINTAINER }),
      status: "ready",
      refresh,
      projectSettings: settings,
    })
    renderOverview()
    const card = await screen.findByTestId("overview-members-card")
    fireEvent.click(within(card).getByTestId("section-visibility-badge"))
    fireEvent.click(await screen.findByRole("combobox", { name: /who can see this section/i }))
    return card
  }

  it("lets a project maintainer make the member list stricter, from the collapsed header", async () => {
    const settings = projectSettingsMock({ rosterOrg: ROLE.MAINTAINER })
    const card = await openMembersPicker(settings)
    expect(card).toHaveAttribute("data-expanded", "false")
    expect(screen.queryByTestId("settings-members-section")).not.toBeInTheDocument()

    choose(await screen.findByRole("option", { name: /owners only/i }))
    await waitFor(() => expect(settings.patch).toHaveBeenCalledWith({ rosterViewMinRole: ROLE.OWNER }))
    expect(card).toHaveAttribute("data-expanded", "false")
  })

  it("offers nothing looser than the org's setting, labels the org's own, and says why", async () => {
    const settings = projectSettingsMock({ rosterOrg: ROLE.MAINTAINER })
    await openMembersPicker(settings)

    for (const name of [/everyone with access/i, /contributors and up/i, /project leads and up/i]) {
      expect(await screen.findByRole("option", { name })).toHaveAttribute("aria-disabled", "true")
    }
    expect(screen.getByRole("option", { name: "Maintainers and owners (org default)" })).not.toHaveAttribute("aria-disabled", "true")
    choose(screen.getByRole("option", { name: /everyone with access/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settings.patch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /why some options are unavailable/i }))
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveTextContent(
      "A project can only be stricter than its organization, which is set to “Maintainers and owners”.",
    )
  })

  it("says in the badge's popover whether the project follows the org or set its own", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock({ rosterOrg: ROLE.MAINTAINER }),
    })
    const view = renderOverview()
    const following = within(await screen.findByTestId("overview-members-card")).getByTestId("section-visibility-badge")
    expect(following).toHaveTextContent(/^Only maintainers & owners can see this$/)
    fireEvent.click(following)
    expect(await screen.findByTestId("section-visibility-origin")).toHaveTextContent("Follows your org's setting.")
    view.unmount()

    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock({ rosterOrg: ROLE.MAINTAINER, rosterOwn: ROLE.OWNER }),
    })
    renderOverview()
    const own = within(await screen.findByTestId("overview-members-card")).getByTestId("section-visibility-badge")
    expect(own).toHaveTextContent(/^Only owners can see this$/)
    fireEvent.click(own)
    expect(await screen.findByTestId("section-visibility-origin")).toHaveTextContent(
      "Stricter than your org (Maintainers and owners). Pick “Maintainers and owners (org default)” to undo.",
    )
  })

  // Sam, 2026-10-13: a Members change that moves the Team card's level is
  // called out in amber under the Team badge; a Team change of its own is not.
  it("says in amber under the Team badge when a Members change moved it", async () => {
    const owner = (settings: ReturnType<typeof projectSettingsMock>) => ({
      project: projectRecord({ level: ROLE.OWNER }),
      status: "ready",
      refresh,
      projectSettings: settings,
    })
    useProject.mockReturnValue(owner(projectSettingsMock({ rosterOrg: ROLE.CONTRIBUTOR, progressOrg: ROLE.MAINTAINER })))
    const view = renderOverview()
    await screen.findByTestId("overview-team-card")
    expect(screen.queryByTestId("overview-team-visibility-moved")).toBeNull()

    // Members raised to owners only: the Team card follows it up.
    useProject.mockReturnValue(owner(projectSettingsMock({ rosterOrg: ROLE.CONTRIBUTOR, rosterOwn: ROLE.OWNER, progressOrg: ROLE.MAINTAINER })))
    view.rerender(overviewTree())
    await screen.findByTestId("overview-team-visibility-moved")
    const why = () => screen.getByTestId("overview-team-visibility-moved-why")
    expect(why()).toHaveAttribute("data-state", "closed")
    expect(why()).toHaveAttribute("aria-hidden", "true")
    fireEvent.click(screen.getByTestId("overview-team-visibility-moved-info"))
    expect(why()).toHaveAttribute("data-state", "open")
    expect(why()).toHaveTextContent("Changed to “Owners only” because Members changed.")
    // The (i) closes it again.
    fireEvent.click(screen.getByTestId("overview-team-visibility-moved-info"))
    expect(why()).toHaveAttribute("data-state", "closed")
    fireEvent.click(screen.getByTestId("overview-team-visibility-moved-info"))

    // Members back to the org's: the Team card drops back to its own setting.
    useProject.mockReturnValue(owner(projectSettingsMock({ rosterOrg: ROLE.CONTRIBUTOR, progressOrg: ROLE.MAINTAINER })))
    view.rerender(overviewTree())
    // A new move starts with the why tucked away again.
    await waitFor(() => expect(why()).toHaveAttribute("data-state", "closed"))
    fireEvent.click(screen.getByTestId("overview-team-visibility-moved-info"))
    expect(why()).toHaveTextContent("Changed to “Maintainers and owners” because Members changed.")

    // A Team change of its own clears the note.
    useProject.mockReturnValue(owner(projectSettingsMock({ rosterOrg: ROLE.CONTRIBUTOR, progressOrg: ROLE.MAINTAINER, progressOwn: ROLE.OWNER })))
    view.rerender(overviewTree())
    await waitFor(() => expect(screen.queryByTestId("overview-team-visibility-moved")).toBeNull())
  })

  it("choosing the org's setting clears the project's own value, so the project follows the org again", async () => {
    // An owner (who still meets the project's owners-only member list).
    const settings = projectSettingsMock({ rosterOrg: ROLE.MAINTAINER, rosterOwn: ROLE.OWNER })
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER }),
      status: "ready",
      refresh,
      projectSettings: settings,
    })
    renderOverview()
    const card = await screen.findByTestId("overview-members-card")
    fireEvent.click(within(card).getByTestId("section-visibility-badge"))
    fireEvent.click(await screen.findByRole("combobox", { name: /who can see this section/i }))

    choose(await screen.findByRole("option", { name: "Maintainers and owners (org default)" }))
    await waitFor(() => expect(settings.patch).toHaveBeenCalledWith({ rosterViewMinRole: undefined }))
  })

  it("shows neither card until the project's own settings arrive, so nothing flashes open", async () => {
    // The org's floor (Maintainer) would admit this maintainer; the project's
    // settings, still loading, may close the list to owners.
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.MAINTAINER }),
      status: "ready",
      refresh,
      projectSettings: { ...projectSettingsMock(), hasFetched: false, orgPolicy: null, visibilityFloors: null },
    })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-team-card")).not.toBeInTheDocument()
  })

  it("says why when the server refuses the change, instead of letting it vanish", async () => {
    toastAdd.mockClear()
    const settings = projectSettingsMock({ rosterOrg: ROLE.MAINTAINER })
    settings.patch.mockResolvedValue({
      kind: "error",
      // patchProjectSettings hands over the body's `error`, not the raw JSON.
      message: "rosterViewMinRole 400 is below the organization's setting (600).",
    } as never)
    await openMembersPicker(settings)

    choose(await screen.findByRole("option", { name: /owners only/i }))
    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Couldn't change who can see this section",
      description: "rosterViewMinRole 400 is below the organization's setting (600).",
    }))
  })

  it("says nothing when the change saves", async () => {
    toastAdd.mockClear()
    const settings = projectSettingsMock({ rosterOrg: ROLE.MAINTAINER })
    await openMembersPicker(settings)
    choose(await screen.findByRole("option", { name: /owners only/i }))
    await waitFor(() => expect(settings.patch).toHaveBeenCalled())
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("hides the card from a maintainer once this project raised its member list to owners", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.MAINTAINER }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock({ rosterOrg: ROLE.MAINTAINER, rosterOwn: ROLE.OWNER }),
    })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
    // The Team card lists the same people, so it closes with it.
    expect(screen.queryByTestId("overview-team-card")).not.toBeInTheDocument()
  })

  it("offers the picker to a project owner who is not an org owner — it changes only this project", async () => {
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockResolvedValue([
      { id: 1, name: "Come and See", role: { level: ROLE.MAINTAINER, name: "maintainer" } },
    ])
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock(),
    })
    renderOverview()

    const card = await screen.findByTestId("overview-members-card")
    const badge = within(card).getByTestId("section-visibility-badge")
    expect(badge.tagName).toBe("BUTTON")
    expect(badge.querySelector("svg.lucide-chevron-down")).toBeInTheDocument()
  })

  it("does not offer the floor picker to a caller who cannot edit the project's settings", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 600 }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock({ canEdit: false }),
    })
    renderOverview()

    const card = await screen.findByTestId("overview-members-card")
    const badge = within(card).getByTestId("section-visibility-badge")
    expect(badge.querySelector("svg.lucide-chevron-down")).not.toBeInTheDocument()
    expect(within(badge).queryByRole("button")).not.toBeInTheDocument()
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
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({ validations: [], roster: [
      { userId: 1, username: "alice", openAssignments: 2, cellsTotal: 10, cellsDone: 4 },
    ] })
  }

  // getProjectTeamProgress.mockResolvedValue persists across tests (clearAllMocks
  // clears call history, not implementation) — restore the file-wide empty
  // default so later describe blocks don't inherit this suite's workload.
  afterEach(async () => {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({ roster: [], validations: [] })
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
    // AQU-1172: the collapse affordance must not leak a header-only Team card
    // to a below-floor viewer.
    expect(screen.queryByTestId("overview-team-card")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-team-toggle")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Team" })).not.toBeInTheDocument()
  })
})

// AQU-1771: a refused read is not an empty one. The card used to catch the
// 403 into an empty list and say "No open assignments in this project yet."
describe("ProjectOverview Team card when the server refuses the read (AQU-1771)", () => {
  afterEach(async () => {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({ roster: [], validations: [] })
  })

  it("hides the card instead of claiming there are no open assignments", async () => {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    const { UserError } = await import("@/lib/errors/user-error")
    vi.mocked(getProjectTeamProgress).mockRejectedValue(new UserError(403, "", "project"))
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    await waitFor(() => expect(vi.mocked(getProjectTeamProgress)).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId("overview-team-card")).not.toBeInTheDocument())
    expect(screen.queryByText("No open assignments in this project yet.")).not.toBeInTheDocument()
  })

  it("still says there are no open assignments when the read succeeds empty", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    expect(await screen.findByText("No open assignments in this project yet.")).toBeInTheDocument()
  })
})

// ── AQU-1969: validate assignments on the Team card ─────────────────────────
describe("ProjectOverview Team card validators (AQU-1969)", () => {
  const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })
  afterEach(async () => {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({ roster: [], validations: [] })
  })

  it("lists each validator's own approvals apart from the translate rows, furthest behind first", async () => {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({
      roster: [{ userId: 1, username: "alice", openAssignments: 1, cellsTotal: 10, cellsDone: 4 }],
      validations: [
        {
          assignmentId: "v-near", assigneeUserId: 3, username: "bo", scopeLabel: "Deuteronomy 11",
          targetLang: "", deadline: null, validation: { text: counts(10, 9, 0, 0), audio: counts(10, 0, 10, 0) },
        },
        {
          assignmentId: "v-far", assigneeUserId: 2, username: "ana", scopeLabel: "Deuteronomy 1–10",
          targetLang: "", deadline: null, validation: { text: counts(40, 34, 0, 2), audio: counts(40, 0, 40, 0) },
        },
      ],
    })
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
      canViewMemberProgress: true,
    })
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    const list = await screen.findByTestId("overview-team-validations")
    expect(within(list).getByRole("heading", { name: "Validation assignments" })).toBeInTheDocument()
    const rows = within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-testid"))
    expect(rows).toEqual(["overview-team-validation-v-far", "overview-team-validation-v-near"])
    expect(screen.getByTestId("overview-team-validation-text-v-far").textContent).toBe(
      "Deuteronomy 1–10 · Validated 34 of 40 · 6 left · 2 changed since",
    )
    // The translator's row is still there, unchanged.
    expect(await screen.findByRole("button", { name: "View activity for alice" })).toBeInTheDocument()
    expect(screen.queryByText("No open assignments in this project yet.")).not.toBeInTheDocument()
  })

  it("does not call a project with only validators empty", async () => {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({
      roster: [],
      validations: [{
        assignmentId: "v1", assigneeUserId: 2, username: "ana", scopeLabel: "Genesis",
        targetLang: "", deadline: null, validation: { text: counts(4, 4, 0, 0), audio: counts(4, 0, 4, 0) },
      }],
    })
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
      canViewMemberProgress: true,
    })
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    expect(await screen.findByTestId("overview-team-validation-v1")).toBeInTheDocument()
    expect(screen.queryByText("No open assignments in this project yet.")).not.toBeInTheDocument()
  })
})

// ── AQU-1172: Team card expand/collapse ─────────────────────────────────────

describe("ProjectOverview Team card collapse (AQU-1172)", () => {
  // WHY: managers can tuck the assignments surface away without leaving the
  // overview. Unlike Members (AQU-1171), Team starts expanded so first load
  // is the working surface plus a chevron — collapse is per-page-load only.

  async function withWorkload() {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({ validations: [], roster: [
      { userId: 1, username: "alice", openAssignments: 2, cellsTotal: 10, cellsDone: 4 },
    ] })
  }

  afterEach(async () => {
    const { getProjectTeamProgress } = await import("@/lib/sync/assignments")
    vi.mocked(getProjectTeamProgress).mockResolvedValue({ roster: [], validations: [] })
  })

  it("starts expanded and hides the body when the header is clicked", async () => {
    await withWorkload()
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
      canViewMemberProgress: true,
    })
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    const card = await screen.findByTestId("overview-team-card")
    expect(card).toHaveAttribute("data-expanded", "true")
    expect(screen.getByTestId("overview-team-toggle")).toHaveAttribute("aria-expanded", "true")
    expect(within(card).getByRole("heading", { name: "Team" })).toBeInTheDocument()
    expect(within(card).getByTestId("section-visibility-badge")).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "View activity for alice" })).toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-team-toggle"))

    expect(card).toHaveAttribute("data-expanded", "false")
    expect(screen.getByTestId("overview-team-toggle")).toHaveAttribute("aria-expanded", "false")
    expect(within(card).getByRole("heading", { name: "Team" })).toBeInTheDocument()
    expect(within(card).getByTestId("section-visibility-badge")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View activity for alice" })).not.toBeInTheDocument()
    expect(screen.queryByText("alice")).not.toBeInTheDocument()
    expect(screen.queryByText("No open assignments in this project yet.")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-team-toggle"))

    expect(card).toHaveAttribute("data-expanded", "true")
    expect(await screen.findByRole("button", { name: "View activity for alice" })).toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()
  })

  it("hides the Team card from a maintainer when the roster floor is owner-only", async () => {
    // The progress floor can still say maintainer. Leaving the card open
    // under "Only maintainers & owners can see this" is the roster choice
    // appearing not to stick.
    await withWorkload()
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: ROLE.OWNER,
      canViewRoster: false,
      memberProgressViewMinRole: ROLE.MAINTAINER,
      canViewMemberProgress: true,
    })
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.MAINTAINER, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-team-card")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-team-toggle")).not.toBeInTheDocument()
    expect(screen.queryByText(/maintainers & owners/i)).not.toBeInTheDocument()
    expect(screen.queryByText("alice")).not.toBeInTheDocument()
  })

  it("keeps the Team badge on owners after the roster floor is raised", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: ROLE.OWNER,
      canViewRoster: true,
      memberProgressViewMinRole: ROLE.MAINTAINER,
      canViewMemberProgress: true,
    })
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    const card = await screen.findByTestId("overview-team-card")
    expect(within(card).getByTestId("section-visibility-badge")).toHaveTextContent(/only owners can see this/i)
    expect(within(card).getByTestId("section-visibility-badge")).not.toHaveTextContent(/maintainers & owners/i)
  })

  // AQU-1771: the Team badge shows the higher of the progress and member-list
  // floors THIS project enforces, and writes this project's own progress
  // floor — never below the org's, and never below the member list (AQU-1779:
  // such a value would save and not show).
  async function openTeamPicker(floors: Parameters<typeof projectSettingsMock>[0] = {}) {
    const settings = projectSettingsMock(floors)
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER, orgId: 1 }),
      status: "ready",
      refresh,
      projectSettings: settings,
    })
    renderOverview()
    const card = await screen.findByTestId("overview-team-card")
    fireEvent.click(within(card).getByTestId("section-visibility-badge"))
    fireEvent.click(await screen.findByRole("combobox", { name: /who can see this section/i }))
    return settings.patch
  }

  function choose(option: HTMLElement) {
    fireEvent.pointerMove(option)
    fireEvent.mouseMove(option)
    fireEvent.keyDown(option, { key: "Enter" })
  }

  it("offers the Team picker to whoever may edit the project's settings, and not to anyone else", async () => {
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockResolvedValue([
      { id: 1, name: "Come and See", role: { level: ROLE.MAINTAINER, name: "maintainer" } },
    ])
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER, orgId: 1 }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock(),
    })
    const view = renderOverview()
    const badge = within(await screen.findByTestId("overview-team-card")).getByTestId("section-visibility-badge")
    expect(badge.tagName).toBe("BUTTON")
    view.unmount()

    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.OWNER, orgId: 1 }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock({ canEdit: false }),
    })
    renderOverview()
    const readOnly = within(await screen.findByTestId("overview-team-card")).getByTestId("section-visibility-badge")
    expect(readOnly.querySelector("svg.lucide-chevron-down")).not.toBeInTheDocument()
  })

  it("persists an owner-only Team floor on the project from the header", async () => {
    const patch = await openTeamPicker()
    choose(await screen.findByRole("option", { name: /owners only/i }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ memberProgressViewMinRole: ROLE.OWNER }))
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).not.toHaveBeenCalledWith(expect.objectContaining({ rosterViewMinRole: expect.anything() }))
  })

  it("disables Team floors below the org's and says why", async () => {
    const patch = await openTeamPicker({ progressOrg: ROLE.MAINTAINER, rosterOrg: ROLE.MAINTAINER })

    for (const name of [/everyone with access/i, /contributors and up/i, /project leads and up/i]) {
      expect(await screen.findByRole("option", { name })).toHaveAttribute("aria-disabled", "true")
    }
    expect(screen.getByRole("option", { name: "Maintainers and owners (org default)" })).not.toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("option", { name: /owners only/i })).not.toHaveAttribute("aria-disabled", "true")

    choose(screen.getByRole("option", { name: /everyone with access/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patch).not.toHaveBeenCalled()

    // The why sits behind a circled-i, collapsed until clicked.
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveAttribute("data-state", "closed")
    fireEvent.click(screen.getByRole("button", { name: /why some options are unavailable/i }))
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveAttribute("data-state", "open")
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveTextContent(
      "A project can only be stricter than its organization, which is set to “Maintainers and owners”. To go lower, an org owner lowers it in Settings → Security first.",
    )
  })

  it("names the member list in the hint when it, not the org's progress setting, is what blocks going lower", async () => {
    await openTeamPicker({ progressOrg: ROLE.CONTRIBUTOR, rosterOrg: ROLE.MAINTAINER })

    expect(await screen.findByRole("option", { name: /project leads and up/i })).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(screen.getByRole("button", { name: /why some options are unavailable/i }))
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveTextContent(
      "This card lists members, and the member list is set to “Maintainers and owners”. To go lower, lower it on the Members card or in Settings → Security first.",
    )
  })

  it("writes nothing when the org's shown value is picked again and the project follows the org", async () => {
    const patch = await openTeamPicker({ progressOrg: ROLE.MAINTAINER, rosterOrg: ROLE.MAINTAINER })

    choose(await screen.findByRole("option", { name: /maintainers and owners/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patch).not.toHaveBeenCalled()
  })

  it("offers 'Follow the org' while the project has its own progress value, and it clears it", async () => {
    const patch = await openTeamPicker({ progressOrg: ROLE.MAINTAINER, progressOwn: ROLE.OWNER })

    choose(await screen.findByRole("option", { name: "Follow the org (Maintainers and owners)" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ memberProgressViewMinRole: undefined }))
  })

  it("can always clear the project's own progress value, even when the member list is what the card then shows", async () => {
    // Org progress is Contributors, the member list Maintainers: no level
    // option can mean "follow the org" here, so the follow option is the way.
    const patch = await openTeamPicker({ progressOrg: ROLE.CONTRIBUTOR, rosterOrg: ROLE.MAINTAINER, progressOwn: ROLE.OWNER })

    choose(await screen.findByRole("option", { name: "Follow the org (Maintainers and owners)" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ memberProgressViewMinRole: undefined }))
  })

  it("offers no 'Follow the org' while the project already follows it", async () => {
    await openTeamPicker({ progressOrg: ROLE.MAINTAINER, rosterOrg: ROLE.MAINTAINER })
    expect(await screen.findByRole("option", { name: "Maintainers and owners (org default)" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /follow the org/i })).not.toBeInTheDocument()
  })

  // Sam, 2026-10-13: "Owners only" binds maintainers — only an owner may
  // loosen it. A maintainer never even gets the picker for it: the Team card
  // is closed to them under an Owners-only progress value.
  it("gives a maintainer no Team picker under the project's own Owners-only progress value", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.MAINTAINER, orgId: 1 }),
      status: "ready",
      refresh,
      projectSettings: projectSettingsMock({ progressOrg: ROLE.MAINTAINER, progressOwn: ROLE.OWNER }),
    })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-team-card")).not.toBeInTheDocument()
  })

  it("stores a Team value that only matches the member list, rather than following the org", async () => {
    // Org progress is Contributors, the member list Maintainers: the card shows
    // Maintainers. Choosing Maintainers is this project's own choice for the
    // Team card — if the member list is lowered later, the card stays put.
    const patch = await openTeamPicker({ progressOrg: ROLE.CONTRIBUTOR, rosterOrg: ROLE.MAINTAINER, progressOwn: ROLE.OWNER })

    const maintainers = await screen.findByRole("option", { name: "Maintainers and owners" })
    choose(maintainers)
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ memberProgressViewMinRole: ROLE.MAINTAINER }))
  })

  it("leaves only Owners only open under an owner-only member list", async () => {
    await openTeamPicker({ progressOrg: ROLE.MAINTAINER, rosterOrg: ROLE.OWNER })

    expect(await screen.findByRole("option", { name: /maintainers and owners/i })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("option", { name: /owners only/i })).not.toHaveAttribute("aria-disabled", "true")
    fireEvent.click(screen.getByRole("button", { name: /why some options are unavailable/i }))
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveTextContent("“Owners only”")
  })

  it("offers every Team floor when the org opens both to everyone, and writes only the progress floor", async () => {
    const patch = await openTeamPicker({ progressOrg: ROLE.VIEWER, rosterOrg: ROLE.VIEWER, progressOwn: ROLE.MAINTAINER })

    const contributors = await screen.findByRole("option", { name: /contributors and up/i })
    expect(contributors).not.toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByRole("button", { name: /why some options are unavailable/i })).not.toBeInTheDocument()

    choose(contributors)
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ memberProgressViewMinRole: ROLE.CONTRIBUTOR }))
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it("starts expanded again after a fresh mount, with no saved collapsed state", async () => {
    await withWorkload()
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    const view = renderOverview()

    fireEvent.click(await screen.findByTestId("overview-team-toggle"))
    expect(screen.getByTestId("overview-team-card")).toHaveAttribute("data-expanded", "false")
    expect(screen.queryByRole("button", { name: "View activity for alice" })).not.toBeInTheDocument()

    view.unmount()
    renderOverview()

    const card = await screen.findByTestId("overview-team-card")
    expect(card).toHaveAttribute("data-expanded", "true")
    expect(await screen.findByRole("button", { name: "View activity for alice" })).toBeInTheDocument()
    expect(screen.getByTestId("overview-members-card")).toHaveAttribute("data-expanded", "false")
  })

  it("keeps Team and Members collapse independent", async () => {
    await withWorkload()
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    const team = await screen.findByTestId("overview-team-card")
    const members = await screen.findByTestId("overview-members-card")
    expect(team.nextElementSibling).toBe(members)
    expect(team).toHaveAttribute("data-expanded", "true")
    expect(members).toHaveAttribute("data-expanded", "false")

    fireEvent.click(screen.getByTestId("overview-team-toggle"))
    expect(team).toHaveAttribute("data-expanded", "false")
    expect(members).toHaveAttribute("data-expanded", "false")
    expect(team.nextElementSibling).toBe(members)

    fireEvent.click(screen.getByTestId("overview-members-toggle"))
    expect(team).toHaveAttribute("data-expanded", "false")
    expect(members).toHaveAttribute("data-expanded", "true")
    expect(screen.getByTestId("settings-members-section")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View activity for alice" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-team-toggle"))
    expect(team).toHaveAttribute("data-expanded", "true")
    expect(members).toHaveAttribute("data-expanded", "true")
    expect(await screen.findByRole("button", { name: "View activity for alice" })).toBeInTheDocument()
    expect(screen.getByTestId("settings-members-section")).toBeInTheDocument()
  })

  it("restores teammate activity after a collapse/expand cycle", async () => {
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
    useProject.mockReturnValue({
      project: projectRecord({ level: 700, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    fireEvent.click(await screen.findByRole("button", { name: "View activity for alice" }))
    expect(await screen.findByTestId("member-activity-panel")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-team-toggle"))
    expect(screen.queryByTestId("member-activity-panel")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("overview-team-toggle"))
    const panel = await screen.findByTestId("member-activity-panel")
    expect(within(panel).getByText("Genesis")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "View activity for alice" }))
    expect(screen.queryByTestId("member-activity-panel")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "View activity for alice" }))
    expect(await screen.findByTestId("member-activity-panel")).toBeInTheDocument()
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
    // AQU-1764: ONE two-part bar per lane (it was an amber bar and an emerald
    // one): validated, then translated but not validated.
    const parts = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>("[data-progress-tone]")]
      .map((part) => `${part.dataset.progressTone} ${part.style.width}`)
    expect(defaultRow.querySelectorAll('[data-slot="progress-split-bar"]')).toHaveLength(1)
    expect(parts(defaultRow)).toEqual(["textValidated 50%", "textTranslated 30%"])
    expect(parts(esRow)).toEqual(["textValidated 8%", "textTranslated 12%"])
  })

  it("AQU-1458: tucks archived lanes into a collapsed group and keeps a one-active-lane project visible", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({
      lanes: [
        { lane: "", totalCells: 100, filledCells: 80, validatedCells: 50, lastEditAt: NOW },
        { lane: "sw", name: "Swahili", totalCells: 100, filledCells: 20, validatedCells: 8, lastEditAt: NOW, archived: true, position: 1 },
        { lane: "fr", name: "French", totalCells: 100, filledCells: 10, validatedCells: 4, lastEditAt: NOW, archived: true, position: 2 },
      ],
    })])
    renderOverview()

    const table = await screen.findByTestId("overview-lane-table")
    expect(within(table).getByTestId("overview-lane-row-default")).toBeInTheDocument()
    expect(within(table).queryByTestId("overview-lane-row-sw")).not.toBeInTheDocument()
    expect(within(table).queryByTestId("overview-lane-actions-sw")).not.toBeInTheDocument()
    expect(screen.queryByTestId("lane-filter-tabs")).not.toBeInTheDocument()

    const toggle = within(table).getByTestId("overview-lane-archived-toggle")
    expect(toggle).toHaveTextContent("Archived (2)")
    expect(within(table).queryByTestId("overview-lane-archived-row-sw")).not.toBeInTheDocument()

    fireEvent.click(toggle)
    const sw = within(table).getByTestId("overview-lane-archived-row-sw")
    const fr = within(table).getByTestId("overview-lane-archived-row-fr")
    expect(sw).toHaveTextContent("Swahili")
    expect(sw).toHaveTextContent("Archived")
    expect(sw).toHaveTextContent("20%")
    // AQU-1764: one dimmed two-part bar, and the validated figure names itself
    // since an archived row has no column headings. AQU-2178: it names which
    // half it is, and a Text language that has recorded nothing shows only the
    // text one — no audio phrase, rather than "0% audio validated".
    expect(sw).toHaveTextContent("8% text validated")
    expect(sw).not.toHaveTextContent("audio validated")
    const archivedBars = sw.querySelectorAll('[data-slot="progress-split-bar"]')
    expect(archivedBars).toHaveLength(1)
    expect(archivedBars[0].className).toContain("opacity-70")
    expect(sw.compareDocumentPosition(fr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(sw).queryByTestId("overview-lane-actions-sw")).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(within(table).queryByTestId("overview-lane-archived-row-sw")).not.toBeInTheDocument()
  })

  // AQU-2180: the Languages card is the only overview card built on the shared
  // Section, so it used to inherit that card's bigger foreground title plus a
  // subtitle no sibling card has. Compared against Progress, the card next to
  // it, because "same as the other headings" is the actual contract.
  it("gives the Languages heading the same type scale as the Progress heading, with no subtitle", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    const table = await screen.findByTestId("overview-lane-table")
    const languages = within(table).getByRole("heading", { level: 2, name: "Languages" })
    const progress = screen.getByRole("heading", { level: 2, name: "Progress" })

    // happy-dom resolves no stylesheet, so the utility classes that decide
    // size, weight and colour are what there is to compare.
    const typeScale = (h: HTMLElement) =>
      h.className
        .split(/\s+/)
        .filter((c) => /^(text-(xs|sm|base|lg)|font-(normal|medium|semibold|bold)|text-(muted-)?foreground)$/.test(c))
        .sort()
    expect(typeScale(languages)).toEqual(typeScale(progress))
    expect(typeScale(languages)).toEqual(["font-semibold", "text-muted-foreground", "text-xs"])

    // The subtitle went with the restyle — the card header is heading + action.
    expect(within(table).queryByText(/each target language on this project/i)).not.toBeInTheDocument()
  })

  it("does not render an archived group when every lane is active", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()
    const table = await screen.findByTestId("overview-lane-table")
    expect(within(table).queryByTestId("overview-lane-archived-toggle")).not.toBeInTheDocument()
  })

  it("AQU-2194: a single-language project shows the Languages table, with Staff… and Assign…, but no lane tabs", async () => {
    // Come and See (Oct 26): a PM needs one place to put a linguist on a
    // language, on every project. With one language the table used to be
    // hidden, so Staff… was out of reach; the progress tabs stay hidden.
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({
      lanes: [{ lane: "", laneId: "lane-bm", totalCells: 100, filledCells: 80, validatedCells: 50, lastEditAt: NOW }],
    })])
    renderOverview()

    const table = await screen.findByTestId("overview-lane-table")
    expect(screen.queryByTestId("lane-filter-tabs")).not.toBeInTheDocument()
    // One row, named by the project's target language (the '' lane).
    const rows = within(table).getAllByTestId(/^overview-lane-row-/)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("Bambara")
    // Its ⋯ menu offers Assign… and Staff….
    fireEvent.click(within(table).getByTestId(/^overview-lane-actions-/))
    expect(await screen.findByRole("menuitem", { name: /^Assign/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /^Staff/ })).toBeInTheDocument()
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

  it("AQU-2116: an audio-only language tab hides the text figures; the text language's tab and All keep them", async () => {
    // One project, two languages: Bambara records and writes nothing, es
    // writes. The rule follows the tab being viewed, and "All" only drops the
    // text figures when NO target language has any text.
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({
      audioCells: 60, validatedAudioCells: 40,
      lanes: [
        { ...TWO_LANES[0], filledCells: 0, validatedCells: 0, audioCells: 60, validatedAudioCells: 40 },
        { ...TWO_LANES[1], audioCells: 0, validatedAudioCells: 0 },
      ],
    })])
    renderOverview()

    await screen.findByTestId("lane-filter-tabs")
    const card = screen.getByTestId("progress-card")

    // All: es has text, so the text figures stay.
    expect(within(card).getAllByText("Translated").length).toBeGreaterThan(0)

    // Bambara (the default lane): recorded, no text → audio figures only.
    fireEvent.click(screen.getByRole("tab", { name: "Bambara" }))
    await waitFor(() => expect(within(card).queryByText("Translated")).not.toBeInTheDocument())
    expect(within(card).queryByTestId("stat-bar-textValidated")).not.toBeInTheDocument()
    expect(statTile("Audio Validated")).toHaveTextContent("20%") // 40 of 200 cells

    // es: has text, owes no audio → its text figures are untouched.
    fireEvent.click(screen.getByRole("tab", { name: "es" }))
    await waitFor(() => expect(within(card).getAllByText("Translated").length).toBeGreaterThan(0))
    expect(statTile("Translated")).toHaveTextContent("20%") // 20 of its 100 cells
  })

  it("AQU-1951: a language tab shows that language's recordings, over the project's audio cells", async () => {
    // Each take belongs to a language (AQU-1591), so audio follows the tab the
    // way text does. AI drafts still have no per-language count and grey out.
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({
      aiDraftedCells: 20, audioCells: 60, validatedAudioCells: 16,
      lanes: [
        { ...TWO_LANES[0], audioCells: 50, validatedAudioCells: 12 },
        { ...TWO_LANES[1], audioCells: 10, validatedAudioCells: 4 },
      ],
    })])
    renderOverview()
    await screen.findByTestId("lane-filter-tabs")
    const card = screen.getByTestId("progress-card")
    const bars = () => within(card).getAllByTestId(/^stat-bar-/).map((b) => b.getAttribute("data-testid"))

    // All: the project's 60 and 16 of 200 cells.
    expect(statTile("Has audio")).toHaveTextContent("30%")
    expect(statTile("Audio Validated")).toHaveTextContent("8%")

    // es: its own 10 and 4, still of the project's 200 cells.
    fireEvent.click(screen.getByRole("tab", { name: "es" }))
    await waitFor(() => expect(statTile("Has audio")).toHaveTextContent("5%"))
    expect(statTile("Audio Validated")).toHaveTextContent("2%")
    for (const label of ["Has audio", "Audio Validated"]) {
      expect(statTile(label).firstElementChild!.className, label).not.toContain("text-muted-foreground/60")
    }
    expect(statTile("AI Drafted").firstElementChild!.className).toContain("text-muted-foreground/60")
    expect(bars()).toEqual([
      "stat-bar-textTranslated", "stat-bar-textValidated", "stat-bar-audioRecorded", "stat-bar-audioValidated",
    ])
    expect(within(card).getByTestId("stat-bar-audioRecorded")).toHaveTextContent("10/200")
    expect(within(card).getByTestId("stat-bar-audioValidated")).toHaveTextContent("4/200")
  })

  it("AQU-1954: a language tab measures audio against that language's own audio total", async () => {
    // The server sends each language what it owes: every file when its
    // "Records audio" switch is on, else the files it has recorded in.
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({
      audioCells: 60, validatedAudioCells: 16, audioTotalCells: 300,
      lanes: [
        { ...TWO_LANES[0], audioCells: 50, validatedAudioCells: 12, audioTotalCells: 100 },
        { ...TWO_LANES[1], audioCells: 10, validatedAudioCells: 4, audioTotalCells: 200, recordsAudio: true },
      ],
    })])
    renderOverview()
    await screen.findByTestId("lane-filter-tabs")
    const card = screen.getByTestId("progress-card")
    // All: both languages' 60 over both languages' 300.
    expect(statTile("Has audio")).toHaveTextContent("20%")
    fireEvent.click(screen.getByRole("tab", { name: "es" }))
    await waitFor(() => expect(statTile("Has audio")).toHaveTextContent("5%"))
    expect(within(card).getByTestId("stat-bar-audioRecorded")).toHaveTextContent("10/200")
    expect(within(card).getByTestId("stat-bar-audioValidated")).toHaveTextContent("4/200")
  })

  it("AQU-1954: a language that is off and has recorded nothing greys its audio and says how to turn it on", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({
      audioCells: 50, validatedAudioCells: 12, audioTotalCells: 100,
      lanes: [
        { ...TWO_LANES[0], audioCells: 50, validatedAudioCells: 12, audioTotalCells: 100 },
        { ...TWO_LANES[1], audioCells: 0, validatedAudioCells: 0, audioTotalCells: 0 },
      ],
    })])
    renderOverview()
    await screen.findByTestId("lane-filter-tabs")
    const card = screen.getByTestId("progress-card")
    const bars = () => within(card).getAllByTestId(/^stat-bar-/).map((b) => b.getAttribute("data-testid"))
    fireEvent.click(screen.getByRole("tab", { name: "es" }))
    await waitFor(() => expect(bars()).not.toContain("stat-bar-audioRecorded"))
    expect(bars()).not.toContain("stat-bar-audioValidated")
    for (const label of ["Has audio", "Audio Validated"]) {
      expect(statTile(label).firstElementChild!.className, label).toContain("text-muted-foreground/60")
    }
  })

  it("greys the cross-language tiles and drops their bars on a language tab when the server sends no lane audio (AQU-1764)", async () => {
    // AI drafts have no per-language breakdown, and an older server sends no
    // lane audio, so with a language tab chosen those tiles grey out (swatch
    // faded with the number) and their bars are not drawn at all.
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject({ aiDraftedCells: 20, audioCells: 60, validatedAudioCells: 15 })])
    renderOverview()
    await screen.findByTestId("lane-filter-tabs")
    const card = screen.getByTestId("progress-card")
    const bars = () => within(card).getAllByTestId(/^stat-bar-/).map((b) => b.getAttribute("data-testid"))
    expect(bars()).toHaveLength(5)

    fireEvent.click(screen.getByRole("tab", { name: "es" }))
    await waitFor(() => expect(bars()).toEqual(["stat-bar-textTranslated", "stat-bar-textValidated"]))
    for (const label of ["AI Drafted", "Has audio", "Audio Validated"]) {
      const tile = statTile(label)
      expect(tile.firstElementChild!.className, label).toContain("text-muted-foreground/60")
      expect(tile.querySelector("[data-progress-swatch]")!.className, label).toContain("opacity-40")
    }
    expect(statTile("Translated").firstElementChild!.className).toContain("text-foreground")
  })

  it("AQU-1566: hidden timeline files are neither counted nor offered for assignment", async () => {
    // A linked video with an attached caption track and a dubbing cue sheet:
    // one document, two timeline files the editor never lists.
    useLaneProject([
      { id: "f-video", name: "Episode", type: "video", createdAt: "x", cellCount: 0 },
      { id: "f-track", name: "Episode captions", type: "vtt", role: "timeline-content", createdAt: "x", cellCount: 500 },
      { id: "f-cues", name: "Episode audio cues", type: "vtt", role: "audio-cues", createdAt: "x", cellCount: 40 },
    ] as ProjectRecord["files"])
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    await screen.findByTestId("overview-lane-table")
    expect(screen.getByText("1 file")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("overview-lane-actions-es"))
    fireEvent.click(screen.getByRole("menuitem", { name: /assign/i }))
    const modal = await screen.findByTestId("assign-modal-mock")
    expect(modal.getAttribute("data-files")).toBe("f-video")
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

  // AQU-1998: the People column is the natural place to go looking for who is
  // on a lane, so it is also the way in to the control that adds and removes
  // them — not just a read-only badge beside the ⋯ menu.
  it("clicking a lane's People avatars opens that lane's Staff popover", async () => {
    useLaneProject()
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    const table = await screen.findByTestId("overview-lane-table")
    const esRow = within(table).getByTestId("overview-lane-row-es")
    expect(within(esRow).getByTestId("staff-lane-mock").getAttribute("data-open")).toBe("false")

    fireEvent.click(within(table).getByTestId("overview-lane-people-es"))

    expect(within(esRow).getByTestId("staff-lane-mock").getAttribute("data-open")).toBe("true")
    // Only that lane's popover opens.
    const defaultRow = within(table).getByTestId("overview-lane-row-default")
    expect(within(defaultRow).getByTestId("staff-lane-mock").getAttribute("data-open")).toBe("false")
    // The row's own click handler must not also fire and navigate away.
    expect(navigate).not.toHaveBeenCalled()
  })

  it("a contributor gets no Staff affordance on the People cell", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.CONTRIBUTOR, targetLanguage: "Bambara", targetLanes: ["es"] }),
      status: "ready",
      refresh,
    })
    getPortfolio.mockResolvedValue([laneProject()])
    renderOverview()

    const table = await screen.findByTestId("overview-lane-table")
    expect(within(table).queryByTestId("overview-lane-people-es")).not.toBeInTheDocument()
    expect(within(table).queryByTestId("overview-lane-actions-es")).not.toBeInTheDocument()
    expect(within(table).queryByTestId("staff-lane-mock")).not.toBeInTheDocument()
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

  it("reads the plan in the language the editor opens when the project has no unnamed one", async () => {
    // AQU-1594: a new project's first language is tagged with its own name and
    // there is no '' lane. Reading '' found no lane at all, so a file with four
    // takes in Spanish showed 0% and no audio bar. An archived lane in first
    // position is passed over, as the editor passes over it.
    const lane = (over: Record<string, unknown>) => ({
      language: null, name: null, langCode: null, archivedAt: null, ...over,
    })
    useProject.mockReturnValue({
      project: projectRecord({
        level: 600,
        lanes: [
          lane({ id: "aaaa0001", role: "source", legacyTag: null, position: 0 }),
          lane({ id: "aaaa0002", role: "target", language: "French", legacyTag: "French", position: 0, archivedAt: "2026-10-01" }),
          lane({ id: "aaaa0003", role: "target", language: "Spanish", legacyTag: "Spanish", position: 1 }),
        ],
      } as Partial<ProjectRecord> & { level: number }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([{
      id: "p1", name: "John", totalCells: 5, filledCells: 0, validatedCells: 0,
      aiDraftedCells: 0, audioCells: 4, validatedAudioCells: 0, recordedMs: 16000,
      lastEditAt: null, deadlineAt: null, sourceLanguage: null, targetLanguage: null,
    }])
    fetchProjectPlan.mockImplementation((_id: string, _tok: string, laneTag: string) => Promise.resolve({
      projectId: "p1", lane: laneTag, validationCount: 1, revision: 1,
      units: [planUnit({ fileName: "Market scene.vtt", totalCount: 5, filledCount: 0, audioCount: laneTag === "Spanish" ? 4 : 0 })],
    }))
    renderOverview()

    const row = await screen.findByTestId("plan-row-f1-")
    await waitFor(() => expect(within(row).getByText("AUD")).toBeInTheDocument())
    expect(fetchProjectPlan.mock.calls.map((c) => c[2])).not.toContain("")
    expect(fetchProjectPlan.mock.calls.map((c) => c[2])).toContain("Spanish")
  })

  it("names the language pair from the lane rows, the project-level languages being retired", async () => {
    // AQU-1977: a project made since AQU-1594 carries no sourceLanguage or
    // targetLanguage, so the header line read nothing at all.
    const lane = (over: Record<string, unknown>) => ({
      language: null, name: null, langCode: null, archivedAt: null, ...over,
    })
    useProject.mockReturnValue({
      project: projectRecord({
        level: 600,
        lanes: [
          lane({ id: "aaaa0001", role: "source", language: "English", legacyTag: null, position: 0 }),
          lane({ id: "aaaa0003", role: "target", language: "Spanish", legacyTag: "Spanish", position: 1 }),
          lane({ id: "aaaa0004", role: "target", language: "French", legacyTag: "French", position: 2 }),
        ],
      } as Partial<ProjectRecord> & { level: number }),
      status: "ready", refresh,
    })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({ projectId: "p1", lane: "Spanish", validationCount: 1, revision: 1, units: [] })
    renderOverview()
    // The arrow is its own span (it mirrors under RTL), so match the whole line.
    expect(await screen.findByText((_, el) =>
      el?.tagName === "P" && /^English\s*→\s*Spanish$/.test(el.textContent?.trim() ?? ""),
    )).toBeInTheDocument()
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
    expect(within(inspector).getByRole("link", { name: /in editor$/ }))
      .toHaveAttribute("href", "/project/p1/editor/file/f1")
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

  // AQU-1914: Assign follows "who can assign work", not "who can see team
  // progress" — the default org hides per-member progress below Maintainer
  // but lets a Project lead assign.
  it("offers Assign to a project lead though the org hides the assignee list from them", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.PROJECT_LEAD }), status: "ready", refresh, roleLevel: ROLE.PROJECT_LEAD,
    })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    renderOverview()

    fireEvent.click(await screen.findByTestId("plan-row-f1-"))
    const inspector = await screen.findByTestId("plan-inspector")
    expect(within(inspector).getByTestId("plan-assign-open")).toBeInTheDocument()
    expect(within(inspector).queryByTestId("plan-assignment-coverage")).toBeNull()
  })

  it("offers Assign to a lane delegate the org allows to assign (AQU-581)", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.CONTRIBUTOR }), status: "ready", refresh, roleLevel: ROLE.CONTRIBUTOR,
    })
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), allowScopedLaneAssignment: true })
    fetchMyScopeGrant.mockResolvedValue({
      scopes: [{ kind: "lane", value: "es" }], allowScopedLaneAssignment: true,
    })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    renderOverview()

    fireEvent.click(await screen.findByTestId("plan-row-f1-"))
    const inspector = await screen.findByTestId("plan-inspector")
    expect(await within(inspector).findByTestId("plan-assign-open")).toBeInTheDocument()
  })

  it("does not offer Assign to a contributor with no way to assign", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: ROLE.CONTRIBUTOR }), status: "ready", refresh, roleLevel: ROLE.CONTRIBUTOR,
    })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    renderOverview()

    fireEvent.click(await screen.findByTestId("plan-row-f1-"))
    const inspector = await screen.findByTestId("plan-inspector")
    await waitFor(() => expect(fetchMyScopeGrant).toHaveBeenCalled())
    expect(within(inspector).queryByTestId("plan-assign-open")).toBeNull()
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

  it("reads every count again when the project's settings change, without a reload (AQU-1493)", async () => {
    // Settings open as a modal OVER this page, so closing them is no remount.
    // Leaving headings out turned Ruth's chapter tiles complete but left the
    // row on 94% and an open chapter card listing blank headings.
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([])
    const ruth = (counts: Record<string, number>) => planUnit({
      fileId: "f1", fileName: "Ruth", sectionKey: "RUT", ...counts,
    })
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1,
      units: [ruth({ totalCount: 93, filledCount: 87, validatedCount: 87 })],
    })
    getFileProgress.mockResolvedValue({
      fileId: "f1", revision: 1, validationCount: 1,
      file: { key: "", totalCount: 93, filledCount: 87, validatedCount: 87 },
      sections: [{ key: "RUT 1", totalCount: 25, filledCount: 22, validatedCount: 22 }],
    })
    getFileSectionProgress.mockResolvedValue({
      verses: [
        { cellId: "h1", ref: "", filled: false, validated: false, structural: true },
        { cellId: "v1", ref: "RUT 1:1", filled: true, validated: true },
      ],
    })
    renderOverview()

    const row = await screen.findByTestId("plan-row-f1-RUT")
    await waitFor(() => expect(row).toHaveTextContent("94%"))
    fireEvent.click(row)
    fireEvent.click(await screen.findByTestId("plan-tile-RUT 1"))
    await waitFor(() => expect(screen.getByTestId("plan-verse-chip-h1")).toBeInTheDocument())
    const planReads = fetchProjectPlan.mock.calls.length
    const progressReads = getFileProgress.mock.calls.length

    // "Leave them out": the server now answers without the headings.
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1,
      units: [ruth({ totalCount: 85, filledCount: 85, validatedCount: 85 })],
    })
    getFileProgress.mockResolvedValue({
      fileId: "f1", revision: 1, validationCount: 1,
      file: { key: "", totalCount: 85, filledCount: 85, validatedCount: 85 },
      sections: [{ key: "RUT 1", totalCount: 22, filledCount: 22, validatedCount: 22 }],
    })
    getFileSectionProgress.mockResolvedValue({
      verses: [{ cellId: "v1", ref: "RUT 1:1", filled: true, validated: true }],
    })
    // What the settings modal broadcasts once its write lands.
    act(() => {
      window.dispatchEvent(new CustomEvent("aquilla:project-settings-updated", {
        detail: { projectId: "p1", version: 2, origin: "settings-modal" },
      }))
    })

    await waitFor(() => expect(fetchProjectPlan.mock.calls.length).toBeGreaterThan(planReads))
    await waitFor(() => expect(screen.getByTestId("plan-row-f1-RUT")).toHaveTextContent("100%"))
    expect(screen.getByTestId("plan-row-f1-RUT")).toHaveTextContent("85 cells")
    // The side panel's tiles and the chapter card still open beneath them.
    expect(getFileProgress.mock.calls.length).toBeGreaterThan(progressReads)
    await waitFor(() => expect(screen.queryByTestId("plan-verse-chip-h1")).toBeNull())
    expect(screen.getByTestId("plan-chapter-detail")).toBeInTheDocument()
  })

  it("ignores a settings change to another project", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    renderOverview()
    await screen.findByTestId("plan-row-f1-")
    await waitFor(() => expect(fetchProjectPlan).toHaveBeenCalled())
    const planReads = fetchProjectPlan.mock.calls.length
    act(() => {
      window.dispatchEvent(new CustomEvent("aquilla:project-settings-updated", {
        detail: { projectId: "someone-else" },
      }))
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchProjectPlan.mock.calls.length).toBe(planReads)
  })

  // AQU-1913: a change made by someone else, another tab or an agent sends
  // this tab no settings-updated event, so the page re-reads on its own.
  it("reads every count again when the tab comes back (AQU-1913)", async () => {
    resetWindowFocusRevalidateForTests()
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    renderOverview()
    await screen.findByTestId("plan-row-f1-")
    await waitFor(() => expect(getPortfolio).toHaveBeenCalled())
    const planReads = fetchProjectPlan.mock.calls.length
    const rowReads = getPortfolio.mock.calls.length

    act(() => { window.dispatchEvent(new Event("focus")) })

    await waitFor(() => expect(fetchProjectPlan.mock.calls.length).toBeGreaterThan(planReads))
    await waitFor(() => expect(getPortfolio.mock.calls.length).toBeGreaterThan(rowReads))
  })

  it("reads every count again when the org's settings version moves (AQU-1913)", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    getPortfolio.mockResolvedValue([])
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [planUnit()],
    })
    const { rerender } = renderOverview()
    await screen.findByTestId("plan-row-f1-")
    await waitFor(() => expect(getPortfolio).toHaveBeenCalled())
    const planReads = fetchProjectPlan.mock.calls.length

    // Another owner turned "count headings" off for the org; this tab's org
    // settings read picked up the new version.
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), version: 2 })
    rerender(overviewTree())

    await waitFor(() => expect(fetchProjectPlan.mock.calls.length).toBeGreaterThan(planReads))
  })
})

it("AQU-1208: the overview exposes Monday setup for a connected project", async () => {
  useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
  mondayLink.mockResolvedValue({ linked: false, orgConnected: true })
  renderOverview()
  expect(await screen.findByRole("link", { name: "Link a board" })).toHaveAttribute("href", "/project/p1/settings/integrations")
  expect(mondayLink).toHaveBeenCalledWith("jwt", "p1")
})

it("AQU-1208: the overview hides the Monday card below maintainer", () => {
  useProject.mockReturnValue({ project: projectRecord({ level: 500 }), status: "ready", refresh })
  mondayLink.mockResolvedValue({ linked: false, orgConnected: true })
  renderOverview()
  expect(screen.queryByLabelText("Monday.com")).toBeNull()
  expect(mondayLink).not.toHaveBeenCalled()
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
      declaredSourceLanguage: null, declaredTargetLanguage: null,
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

  const manyOriginals = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      fileWith(`f${i + 1}`, `Book${String(i + 1).padStart(2, "0")}.usfm`, true),
    )

  it("caps the list at five rows and reveals the rest a batch at a time or all at once", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles(manyOriginals(12))

    renderOverview()

    const card = await screen.findByTestId("imported-originals")
    expect(within(card).getAllByTestId("download-original-file")).toHaveLength(5)
    expect(within(card).getByText("Book05.usfm")).toBeInTheDocument()
    expect(within(card).queryByText("Book06.usfm")).not.toBeInTheDocument()
    expect(within(card).getByRole("button", { name: "Show 5 more" })).toBeInTheDocument()
    expect(within(card).getByRole("button", { name: "Show all (12)" })).toBeInTheDocument()

    fireEvent.click(within(card).getByRole("button", { name: "Show 5 more" }))
    expect(within(card).getAllByTestId("download-original-file")).toHaveLength(10)
    expect(within(card).getByText("Book10.usfm")).toBeInTheDocument()
    // Only two rows are left hidden, so another batch would equal "Show all".
    expect(within(card).queryByRole("button", { name: "Show 5 more" })).not.toBeInTheDocument()

    fireEvent.click(within(card).getByRole("button", { name: "Show all (12)" }))
    expect(within(card).getAllByTestId("download-original-file")).toHaveLength(12)
    expect(within(card).getByText("Book12.usfm")).toBeInTheDocument()
    expect(within(card).queryByRole("button", { name: "Show all (12)" })).not.toBeInTheDocument()

    fireEvent.click(within(card).getByRole("button", { name: "Show fewer" }))
    expect(within(card).getAllByTestId("download-original-file")).toHaveLength(5)
    expect(within(card).queryByText("Book06.usfm")).not.toBeInTheDocument()
  })

  it("expands everything at once from the first page", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles(manyOriginals(23))

    renderOverview()

    const card = await screen.findByTestId("imported-originals")
    expect(within(card).getAllByTestId("download-original-file")).toHaveLength(5)

    fireEvent.click(within(card).getByRole("button", { name: "Show all (23)" }))
    expect(within(card).getAllByTestId("download-original-file")).toHaveLength(23)
    expect(within(card).queryByRole("button", { name: "Show 5 more" })).not.toBeInTheDocument()
    expect(within(card).getByRole("button", { name: "Show fewer" })).toBeInTheDocument()
  })

  it("shows no paging controls when five or fewer files have an original", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles(manyOriginals(5))

    renderOverview()

    const card = await screen.findByTestId("imported-originals")
    expect(within(card).getAllByTestId("download-original-file")).toHaveLength(5)
    expect(within(card).queryByTestId("imported-originals-show-more")).not.toBeInTheDocument()
    expect(within(card).queryByTestId("imported-originals-show-all")).not.toBeInTheDocument()
    expect(within(card).queryByTestId("imported-originals-show-fewer")).not.toBeInTheDocument()
  })
})

// AQU-1969 (Sam, 2026-10-19: "It should be more easy to unassign work"): the
// Team card's validation rows carry the org workload's one-click ×, offered by
// the server's own rule — the org's assignment role in this project.
describe("ProjectOverview one-click unassign (AQU-1969)", () => {
  const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })
  const files = [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 10 }]

  async function withValidation() {
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    const mod = await import("@/lib/sync/assignments")
    vi.mocked(mod.getProjectTeamProgress).mockResolvedValue({
      roster: [],
      validations: [{
        assignmentId: "v1", assigneeUserId: 3, username: "carol", scopeLabel: "GEN 1", targetLang: "",
        deadline: null, validation: { text: counts(7, 2, 2, 0), audio: counts(7, 0, 7, 0) },
      }],
    })
    return mod
  }

  it("a lead removes a validation assignment from the Team card: ×, then Confirm", async () => {
    const mod = await withValidation()
    useProject.mockReturnValue({ project: projectRecord({ level: ROLE.MAINTAINER, files } as never), status: "ready", refresh })
    renderOverview()
    const remove = await screen.findByTestId("overview-team-validation-remove-v1")
    const readsBefore = vi.mocked(mod.getProjectTeamProgress).mock.calls.length
    fireEvent.click(remove)
    expect(mod.unassignAssignment).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("overview-team-validation-remove-v1-confirm"))
    await waitFor(() => expect(mod.unassignAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "f1", assignmentId: "v1" }),
    ))
    // The card is read again, as after an Assign.
    await waitFor(() => expect(vi.mocked(mod.getProjectTeamProgress).mock.calls.length).toBeGreaterThan(readsBefore))
  })

  // Sam, 2026-10-20: an archived project's assignments are frozen with it.
  // AQU-2088 hides an archived project's Team card behind the archived notice,
  // so there is no row to remove from; the × must not appear anywhere either.
  it("an archived project offers no × (its Team card is hidden)", async () => {
    await withValidation()
    useProject.mockReturnValue({ project: projectRecord({ level: ROLE.MAINTAINER, files, deletedAt: "2026-10-01T00:00:00Z" } as never), status: "ready", refresh })
    renderOverview()
    await screen.findByTestId("overview-archived-notice")
    expect(screen.queryByTestId("overview-team-validation-v1")).toBeNull()
    expect(screen.queryByTestId("overview-team-validation-remove-v1")).toBeNull()
  })

  it("a Contributor who can see the card gets no ×", async () => {
    await withValidation()
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: ROLE.CONTRIBUTOR,
      memberProgressViewMinRole: ROLE.CONTRIBUTOR,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: ROLE.CONTRIBUTOR, files } as never), status: "ready", refresh })
    renderOverview()
    await screen.findByTestId("overview-team-validation-v1")
    expect(screen.queryByTestId("overview-team-validation-remove-v1")).toBeNull()
  })
})
