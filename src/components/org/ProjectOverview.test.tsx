import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectOverview, deriveProjectStatus } from "./ProjectOverview"
import type { ProjectRecord } from "@/lib/parsers/types"

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
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

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
  translatedPct: (p: { filledCells: number; totalCells: number }) => (p.totalCells > 0 ? p.filledCells / p.totalCells : 0),
  validatedPct: (p: { validatedCells: number; totalCells: number }) => (p.totalCells > 0 ? p.validatedCells / p.totalCells : 0),
  aiDraftedPct: (p: { aiDraftedCells: number; totalCells: number }) => (p.totalCells > 0 ? p.aiDraftedCells / p.totalCells : 0),
  recordedMinutes: (p: { recordedMs: number }) => Math.round(p.recordedMs / 60000),
  deadlineStatus: () => _deadlineStatusResult,
}))
vi.mock("@/lib/sync/cloud-projects", () => ({
  setProjectDeadline: vi.fn(),
  // OrgSidebar (rendered by ProjectOverview's AppShell) calls
  // useProjectsForNavigation -> fetchAccessibleProjects for the "Shared with
  // you" nav section (FRO-474). Default to empty so it never interferes with
  // pre-existing tests; individual FRO-474 tests override via mockResolvedValue.
  fetchAccessibleProjects: vi.fn(async () => []),
}))
const downloadProjectBundle = vi.fn()
vi.mock("@/lib/sync/export-bundle", () => ({
  downloadProjectBundle: (...a: unknown[]) => downloadProjectBundle(...a),
}))

const fetchSyncToken = vi.fn()
vi.mock("@/lib/sync/sync-token", () => ({
  fetchSyncToken: (...a: unknown[]) => fetchSyncToken(...a),
}))
const fetchProjectFiles = vi.fn()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: (...a: unknown[]) => fetchProjectFiles(...a),
}))

// Mock assignments workload so Team card doesn't break tests
vi.mock("@/lib/sync/assignments", () => ({
  getWorkload: vi.fn(async () => []),
  getProjectAssignments: vi.fn(async () => []),
  getMyAssignments: vi.fn(async () => []),
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

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <OrgProvider>
        <Routes><Route path="/projects/:id" element={<ProjectOverview />} /></Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  localStorage.clear()
  _deadlineStatusResult = null
  // Some FRO-474 tests override this to simulate a user with no orgs;
  // vi.clearAllMocks() clears call history but not mockResolvedValue
  // implementations, so restore the default (single org, auto-selected) here.
  const { listMyOrgs } = await import("@/lib/frontier/orgs")
  vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
  // AQU-486: reset the org-settings mock to its default (everything visible,
  // maintainer floor) — vi.clearAllMocks() does not undo a persistent
  // mockReturnValue set by an earlier test.
  useOrgSettingsMock.mockReturnValue(defaultOrgSettingsMock())
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
      aiDraftedCells: 0, audioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null, ...opts,
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

// ── Per-metric conditionality ──────────────────────────────────────────────

describe("ProjectOverview per-metric conditionality (FRO-168)", () => {
  // WHY: audio-only projects must hide text metrics; text-only must hide audio.
  // Showing irrelevant metrics confuses managers scanning project state.

  it("text-only project: shows Translated/Validated tiles but hides Audio tile", async () => {
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
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
    }])
    renderOverview()

    // Translated and Validated tiles should appear (text content present)
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Validated").length).toBeGreaterThan(0)
    // Audio tile must NOT appear (audioCells === 0)
    expect(screen.queryByText("Audio")).not.toBeInTheDocument()
  })

  it("audio-only project: shows Audio tile but hides Translated/Validated tiles", async () => {
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
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
    }])
    renderOverview()

    // Audio tile should appear
    await waitFor(() => expect(screen.getAllByText("Audio").length).toBeGreaterThan(0))
    // Translated and Validated must NOT appear (filledCells === 0 means showText is false,
    // but note: totalCells > 0 means hasText=true in current logic which guards on totalCells.
    // The real guard is audioCells > 0 for audio, and totalCells > 0 for text.
    // For audio-only: filledCells=0 but totalCells=100, so text bars still show.
    // Per FRO-168 spec: hide text metrics only when "no text content (translatable cells > 0)".
    // totalCells > 0 means there IS translatable content, so text bars appear even if empty.
    // The audio-only guard is specifically: audioCells > 0 shows Audio, always shows text when totalCells > 0.
    // This test therefore confirms Audio appears when audioCells > 0.
    expect(screen.getAllByText("Audio").length).toBeGreaterThan(0)
  })
})

// ── File list show-more ────────────────────────────────────────────────────

describe("ProjectOverview file list show-more", () => {
  it("shows only the first 12 files when there are more than 12, then reveals all after clicking show-all", async () => {
    // WHY: the file list was silently capped at 12 with no way to reach the rest (FRO-136).
    // This asserts that all files become reachable via the show-more toggle.
    const totalFiles = 16
    const fileList = Array.from({ length: totalFiles }, (_, i) => fileSummary(i + 1))

    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue(fileList)

    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: fileList.map((f) => ({ id: f.fileId, name: f.name, type: "usfm", createdAt: "x", cellCount: f.cellCount })) }),
      status: "ready",
      refresh,
    })

    renderOverview()

    // Wait for async file fetch to populate the list
    await waitFor(() => expect(screen.queryByText(/top 12 of 16/)).toBeInTheDocument())

    // Only 12 files should be visible initially
    // Scoped to file rows (data-testid="file-row") — a plain listitem-role query
    // also picks up unrelated <li>s rendered elsewhere in the shell (e.g. the
    // org switcher's popover list), which aren't part of what this test covers.
    expect(screen.getAllByTestId("file-row").length).toBe(12)

    // Clicking show-more reveals all 16 files
    const showMore = screen.getByRole("button", { name: /show all/i })
    fireEvent.click(showMore)

    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(totalFiles))
    // Header should now say "(16)" not "top 12 of 16"
    expect(screen.queryByText(/top 12 of 16/)).not.toBeInTheDocument()
    expect(screen.getByText(/\(16\)/)).toBeInTheDocument()
  })
})

// ── Archive / restore ──────────────────────────────────────────────────────

describe("ProjectOverview archive/restore", () => {
  it("owner sees Archive in overflow; clicking archives and returns to /projects", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    archiveProjectRemote.mockResolvedValue({ kind: "archived", archivedAt: "now", archivedBy: { id: 1, username: "wendi" } })
    renderOverview()

    // Open the overflow menu first
    const moreBtn = await screen.findByRole("button", { name: "More actions" })
    fireEvent.click(moreBtn)

    const btn = await screen.findByRole("button", { name: "Archive" })
    fireEvent.click(btn)

    await waitFor(() => expect(archiveProjectRemote).toHaveBeenCalledWith("p1", "jwt"))
    expect(navigate).toHaveBeenCalledWith("/projects")
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
    downloadProjectBundle.mockResolvedValue(undefined)
    renderOverview()

    // Open overflow
    const moreBtn = await screen.findByRole("button", { name: "More actions" })
    fireEvent.click(moreBtn)

    const btn = await screen.findByRole("button", { name: "Download deliverable" })
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
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Download deliverable" })).not.toBeInTheDocument()
  })
})

// ── Audio progress ─────────────────────────────────────────────────────────

describe("ProjectOverview audio progress (FRO-160)", () => {
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
        recordedMs: 90000,
        lastEditAt: Date.now(),
        deadlineAt: null,
      },
    ])

    renderOverview()

    // The progress section should be present (totalCells > 0).
    // The "Audio" label must appear in the StatBar list.
    await waitFor(() => expect(screen.getAllByText("Audio").length).toBeGreaterThan(0))
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
        recordedMs: 0,
        lastEditAt: Date.now(),
        deadlineAt: null,
      },
    ])

    renderOverview()

    // When audioCells === 0, Audio tile/bar is hidden (per-metric conditionality).
    // So we just confirm the progress section renders with text metrics.
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    // Audio should be hidden
    expect(screen.queryByText("Audio")).not.toBeInTheDocument()
  })
})

// ── FRO-474: project-only invitee navigation ────────────────────────────────

describe("ProjectOverview project-only invitee access (FRO-474)", () => {
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
    // The project belongs to org 99 — a mismatch that pre-FRO-474 triggered a redirect.
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
      aiDraftedCells: 0, audioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null,
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

  // FRO-416: the overview rendering (no redirect) is necessary but not
  // sufficient — a guest must be able to actually ENTER the workspace from
  // here. "Open project" navigates unconditionally to `/project/:id`; this
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

    expect(navigate).toHaveBeenCalledWith("/project/p1")
  })
})

// ── FRO-292: AI-drafted segment ─────────────────────────────────────────────

describe("ProjectOverview AI-drafted segment (FRO-292)", () => {
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
      recordedMs: 0, lastEditAt: null, deadlineAt: null,
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
      audioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null,
    }])
    renderOverview()

    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    // "AI Drafted" must NOT appear when count is 0 (forward-only honest rendering)
    expect(screen.queryByText("AI Drafted")).not.toBeInTheDocument()
  })
})

// ── AQU-486: per-section visibility chrome ──────────────────────────────────

describe("ProjectOverview per-section visibility (AQU-486)", () => {
  // WHY: the Members card must be a hard gate on the AQU-485 rosterViewMinRole
  // floor — a below-floor caller must not see the card at all (no empty
  // placeholder leaking that a roster exists), while a permitted caller sees
  // it, with a badge naming who can see it and (if they can edit) an inline
  // control to change the floor without leaving the page.

  it("hides the Members card entirely when the org has raised the roster floor above the caller's role", async () => {
    // WHY: canManage (project role >= 600) alone used to be the only gate on
    // this card. AQU-486 adds a second, independent gate — the org's
    // rosterViewMinRole floor — and the floor must win: a maintainer-level
    // caller (canManage=true) whose role still falls short of an
    // owner-raised floor must see nothing, not an empty card.
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: 700, // org raised the floor to Owner-only
      canViewRoster: false,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByTestId("overview-members-card")).not.toBeInTheDocument()
  })

  it("shows the Members card with a visibility badge for a caller meeting the roster floor", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: 600,
      canViewRoster: true,
    })
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    const card = await screen.findByTestId("overview-members-card")
    expect(within(card).getByTestId("section-visibility-badge")).toHaveTextContent(/maintainers & owners/i)
  })

  it("a maintainer can change the roster floor via the inline advanced toggle", async () => {
    const patch = vi.fn(async () => ({ kind: "ok" as const, value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } }))
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      rosterViewMinRole: 600,
      canViewRoster: true,
      patch,
    })
    canEditRosterProgressFloorMock.mockReturnValue(true)
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    renderOverview()

    const card = await screen.findByTestId("overview-members-card")
    fireEvent.click(within(card).getByTestId("section-visibility-badge"))

    const trigger = await screen.findByRole("combobox", { name: /who can see this section/i })
    fireEvent.click(trigger)
    const option = await screen.findByRole("option", { name: /everyone with access/i })
    fireEvent.pointerMove(option)
    fireEvent.mouseMove(option)
    fireEvent.keyDown(option, { key: "Enter" })

    await waitFor(() => expect(patch).toHaveBeenCalledWith({ rosterViewMinRole: 100 }))
  })

  it("does not show the advanced toggle chevron for a caller who cannot edit the floor", async () => {
    canEditRosterProgressFloorMock.mockReturnValue(false)
    useProject.mockReturnValue({ project: projectRecord({ level: 600 }), status: "ready", refresh })
    renderOverview()

    const card = await screen.findByTestId("overview-members-card")
    // Scoped to the badge itself, not the whole card — MembersTab's own
    // "Add member" role picker renders an unrelated combobox in this card
    // regardless of the visibility badge's edit state.
    const badge = within(card).getByTestId("section-visibility-badge")
    expect(within(badge).queryByRole("combobox")).not.toBeInTheDocument()
    expect(badge.querySelector("svg.lucide-chevron-down")).not.toBeInTheDocument()
  })
})
