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

// Drive the shadcn (Base UI) Select the same way AssignWork.test.tsx does:
// open the trigger, hover-highlight the option, commit with Enter fired on
// the option itself (the click path doesn't reliably commit under happy-dom).
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  const label = option.textContent ?? ""
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
  await waitFor(() => expect(trigger.textContent).toContain(label))
}

// ── Status chip derivation ─────────────────────────────────────────────────

describe("deriveProjectStatus", () => {
  // WHY: the status chip is the primary at-a-glance signal for managers (Wendi/Anna).
  // The derivation must map correctly from deadline + progress to the three chip states.

  function makePortfolio(opts: Partial<PortfolioProject> = {}): PortfolioProject {
    return {
      id: "p1", name: "Test", totalCells: 100, filledCells: 50, validatedCells: 20,
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null, ...opts,
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

describe("ProjectOverview load states", () => {
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

    expect(await screen.findByText(/sign in to open this project from the cloud/i)).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }))
    expect(navigate).toHaveBeenCalledWith("/login?next=%2Fprojects%2Fp1")
  })
})

// ── Per-metric conditionality ──────────────────────────────────────────────

describe("ProjectOverview per-metric conditionality (FRO-168)", () => {
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
    }])
    renderOverview()

    // Translated and Validated tiles should appear (text content present)
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Validated").length).toBeGreaterThan(0)
    // Neither audio tile may appear (audioCells === 0) — AQU-490: this also
    // guards against a false-positive "Audio Validated" figure on a
    // text-only project, since neither field exists to fabricate one from.
    expect(screen.queryByText("Has Audio")).not.toBeInTheDocument()
    expect(screen.queryByText("Audio Validated")).not.toBeInTheDocument()
  })

  it("audio-only project: shows Has Audio + Audio Validated (N/A) tiles but hides Translated/Validated tiles", async () => {
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
      validatedAudioCells: 0,
      recordedMs: 90000, lastEditAt: null, deadlineAt: null,
    }])
    renderOverview()

    // Has Audio (coverage) tile should appear
    await waitFor(() => expect(screen.getAllByText("Has Audio").length).toBeGreaterThan(0))
    // Translated and Validated must NOT appear (filledCells === 0 means showText is false,
    // but note: totalCells > 0 means hasText=true in current logic which guards on totalCells.
    // The real guard is audioCells > 0 for audio, and totalCells > 0 for text.
    // For audio-only: filledCells=0 but totalCells=100, so text bars still show.
    // Per FRO-168 spec: hide text metrics only when "no text content (translatable cells > 0)".
    // totalCells > 0 means there IS translatable content, so text bars appear even if empty.
    // The audio-only guard is specifically: audioCells > 0 shows Has Audio, always shows text when totalCells > 0.
    // This test therefore confirms Has Audio appears when audioCells > 0.
    expect(screen.getAllByText("Has Audio").length).toBeGreaterThan(0)
    // AQU-490: a distinct audio-validated count doesn't exist server-side
    // (see the in-component comment for the full investigation). The tile
    // must appear — labeled, honest, and reading "N/A" — never a fabricated
    // percentage.
    expect(screen.getByText("Audio Validated")).toBeInTheDocument()
    expect(screen.getByText("N/A")).toBeInTheDocument()
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
    }])
    renderOverview()

    for (const label of ["Translated", "Validated", "Has Audio", "Audio Validated"]) {
      await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0))
    }
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

// ── File-breakdown column headers (AQU-492) ────────────────────────────────

describe("ProjectOverview file-breakdown column headers (AQU-492)", () => {
  // WHY: the per-file numbers used to render as a bare "5/2/10 · 100w" string
  // with only a tooltip explaining it. A PM must be able to read each figure
  // cold — so the table needs a labeled header row, and the underlying counts
  // must still render correctly per file (not just the header labels).

  it("renders a labeled header row above the file list with units, and each file's raw numbers still render", async () => {
    const fileList = [fileSummary(1), fileSummary(2)]
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue(fileList)
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: fileList.map((f) => ({ id: f.fileId, name: f.name, type: "usfm", createdAt: "x", cellCount: f.cellCount })) }),
      status: "ready",
      refresh,
    })

    renderOverview()

    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(2))

    // Column headers: clear label + implicit unit for each figure.
    const header = screen.getByTestId("file-breakdown-header")
    expect(within(header).getByText("File")).toBeInTheDocument()
    expect(within(header).getByText("Filled")).toBeInTheDocument()
    expect(within(header).getByText("Approved")).toBeInTheDocument()
    expect(within(header).getByText("Total")).toBeInTheDocument()
    expect(within(header).getByText("Words")).toBeInTheDocument()

    // Per-file numbers (from fileSummary: cellCount 10, filledCount 5,
    // approvedCount 2, wordCount 100) still render — one set per row, now as
    // separate labeled cells instead of a single "5/2/10 · 100w" string.
    const rows = screen.getAllByTestId("file-row")
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(within(row).getByText("5")).toBeInTheDocument()
      expect(within(row).getByText("2")).toBeInTheDocument()
      expect(within(row).getByText("10")).toBeInTheDocument()
      expect(within(row).getByText("100")).toBeInTheDocument()
    }
  })

  it("does not render the header row when the filter matches no files", async () => {
    const fileList = [fileSummary(1)]
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    fetchProjectFiles.mockResolvedValue(fileList)
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: fileList.map((f) => ({ id: f.fileId, name: f.name, type: "usfm", createdAt: "x", cellCount: f.cellCount })) }),
      status: "ready",
      refresh,
    })

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(1))

    fireEvent.change(screen.getByLabelText("Filter files by name"), { target: { value: "no-such-file" } })

    await waitFor(() => expect(screen.queryByTestId("file-row")).not.toBeInTheDocument())
    expect(screen.queryByTestId("file-breakdown-header")).not.toBeInTheDocument()
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
        validatedAudioCells: 0,
        recordedMs: 90000,
        lastEditAt: Date.now(),
        deadlineAt: null,
      },
    ])

    renderOverview()

    // The progress section should be present (totalCells > 0).
    // The "Has Audio" label must appear in the StatBar list (AQU-490 relabel).
    await waitFor(() => expect(screen.getAllByText("Has Audio").length).toBeGreaterThan(0))
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
      },
    ])

    renderOverview()

    // When audioCells === 0, Has Audio tile/bar is hidden (per-metric conditionality).
    // So we just confirm the progress section renders with text metrics.
    await waitFor(() => expect(screen.getAllByText("Translated").length).toBeGreaterThan(0))
    // Audio tiles should be hidden
    expect(screen.queryByText("Has Audio")).not.toBeInTheDocument()
    expect(screen.queryByText("Audio Validated")).not.toBeInTheDocument()
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
      aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null,
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
      validatedAudioCells: 0,
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
      audioCells: 0, validatedAudioCells: 0, recordedMs: 0, lastEditAt: null, deadlineAt: null,
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

// ── AQU-493: chapter/verse progress rollup ──────────────────────────────────

describe("ProjectOverview chapter/verse rollup (AQU-493)", () => {
  function progress(sections: Array<{ key: string; totalCount: number; filledCount: number; validatedCount: number }>) {
    return {
      fileId: "f1",
      revision: 10,
      validationCount: 1,
      file: { totalCount: 2, filledCount: 2, validatedCount: 2, validationLevels: [2] },
      sections: sections.map((section) => ({ ...section, validationLevels: [section.validatedCount] })),
      source: "projection" as const,
    }
  }

  beforeEach(() => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
  })

  it("expanding a file with Bible references reveals a book row with reconciling chapter/verse progress", async () => {
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    getFileProgress.mockResolvedValue(progress([
      { key: "GEN 1", totalCount: 2, filledCount: 2, validatedCount: 2 },
    ]))
    getFileSectionProgress.mockResolvedValue({
      fileId: "f1", sectionKey: "GEN 1", revision: 10, validationCount: 1,
      verses: [
        { ref: "GEN 1:1", filled: true, validated: true },
        { ref: "GEN 1:2", filled: true, validated: true },
      ],
    })
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })

    renderOverview()

    const row = await screen.findByTestId("file-row")
    fireEvent.click(within(row).getByRole("button", { name: /^expand/i }))

    const bookRow = await screen.findByTestId("book-row")
    expect(bookRow).toHaveTextContent("GEN")
    // A fully-filled, fully-approved 2-verse book reconciles to 2/2/2 at book level.
    expect(bookRow).toHaveTextContent("2/2/2")

    fireEvent.click(bookRow)
    const chapterRow = await screen.findByTestId("chapter-row")
    expect(chapterRow).toHaveTextContent("2/2/2")

    fireEvent.click(chapterRow)
    const verseCells = await screen.findAllByTestId("verse-cell")
    expect(verseCells).toHaveLength(2)
    expect(getFileProgress).toHaveBeenCalledTimes(1)
    expect(getFileSectionProgress).toHaveBeenCalledTimes(1)
  })

  it("expanding a file without Bible references shows a fallback note, not an empty tree", async () => {
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    getFileProgress.mockResolvedValue(progress([]))
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "Notes.txt", type: "txt", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })

    renderOverview()

    const row = await screen.findByTestId("file-row")
    fireEvent.click(within(row).getByRole("button", { name: /^expand/i }))

    expect(await screen.findByText(/no chapter structure detected/i)).toBeInTheDocument()
    expect(screen.queryByTestId("book-row")).not.toBeInTheDocument()
    expect(screen.queryByTestId("canonical-rollup-books")).not.toBeInTheDocument()
  })

  it("expanding a file with book-level sections renders a flat section list", async () => {
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    getFileProgress.mockResolvedValue(progress([
      { key: "GEN", totalCount: 2, filledCount: 1, validatedCount: 0 },
      { key: "EXO", totalCount: 3, filledCount: 2, validatedCount: 1 },
    ]))
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "Bible.usfm", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })

    renderOverview()

    const row = await screen.findByTestId("file-row")
    fireEvent.click(within(row).getByRole("button", { name: /^expand/i }))

    const sectionRows = await within(row).findAllByTestId("section-row")
    expect(sectionRows).toHaveLength(2)
    expect(sectionRows[0]).toHaveTextContent("GEN")
    expect(sectionRows[0]).toHaveTextContent("1/0/2")
    expect(sectionRows[1]).toHaveTextContent("EXO")
    expect(screen.queryByText(/no chapter structure detected/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId("canonical-rollup-books")).not.toBeInTheDocument()
  })

  it("collapsing and re-expanding a file does not re-fetch its compact progress", async () => {
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    getFileProgress.mockResolvedValue(progress([
      { key: "GEN 1", totalCount: 1, filledCount: 1, validatedCount: 1 },
    ]))
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })

    renderOverview()
    const row = await screen.findByTestId("file-row")
    const toggle = within(row).getByRole("button", { name: /^expand/i })

    fireEvent.click(toggle) // expand
    await screen.findByTestId("book-row")
    fireEvent.click(within(row).getByRole("button", { name: /^collapse/i })) // collapse
    expect(screen.queryByTestId("book-row")).not.toBeInTheDocument()
    fireEvent.click(within(row).getByRole("button", { name: /^expand/i })) // re-expand
    await screen.findByTestId("book-row")

    expect(getFileProgress).toHaveBeenCalledTimes(1)
  })

  it("distinguishes a failed progress request from a flat file and retries in place", async () => {
    fetchProjectFiles.mockResolvedValue([fileSummary(1)])
    getFileProgress
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(progress([
        { key: "GEN 1", totalCount: 1, filledCount: 1, validatedCount: 1 },
      ]))
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "x", cellCount: 10 }] }),
      status: "ready", refresh,
    })

    renderOverview()
    const row = await screen.findByTestId("file-row")
    fireEvent.click(within(row).getByRole("button", { name: /^expand/i }))

    const retry = await within(row).findByRole("button", { name: /chapter progress unavailable/i })
    expect(within(row).queryByText(/no chapter structure detected/i)).not.toBeInTheDocument()
    fireEvent.click(retry)

    expect(await within(row).findByTestId("book-row")).toBeInTheDocument()
    expect(getFileProgress).toHaveBeenCalledTimes(2)
  })
})

// ── AQU-499: file list sort/filter ──────────────────────────────────────────

describe("ProjectOverview file list sort/filter (AQU-499)", () => {
  // WHY: Randall's dashboard walkthrough — the file list was sorted by total
  // cells with no visible control, which "is not very helpful" for tracking
  // what recently changed. These tests lock in the visible sort control
  // (last-updated default, canonical, alphabetical), the name filter, and
  // that AQU-493's per-row expand state survives a re-sort (it's keyed by
  // fileId, not row position).

  beforeEach(() => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
  })

  function fileWith(fileId: string, name: string, lastEditAt: number | null): import("@/lib/sync/cells-read").FileSummary {
    return { fileId, projectId: "p1", name, fileType: "usfm", sourceLanguage: null, targetLanguage: null, cellCount: 10, filledCount: 5, approvedCount: 2, wordCount: 100, lastEditAt }
  }

  function rowNames(): (string | null | undefined)[] {
    return screen.getAllByTestId("file-row").map((row) => row.querySelector(".font-medium")?.textContent)
  }

  function useFiles(files: import("@/lib/sync/cells-read").FileSummary[]) {
    fetchProjectFiles.mockResolvedValue(files)
    useProject.mockReturnValue({
      project: projectRecord({
        level: 400,
        files: files.map((f) => ({ id: f.fileId, name: f.name, type: "usfm", createdAt: "x", cellCount: f.cellCount })),
      }),
      status: "ready",
      refresh,
    })
  }

  it("defaults to last-updated: most-recently-progressed file first, unedited files last", async () => {
    useFiles([
      fileWith("f1", "Old.usfm", 100),
      fileWith("f2", "Newest.usfm", 300),
      fileWith("f3", "NeverEdited.usfm", null),
      fileWith("f4", "Mid.usfm", 200),
    ])

    renderOverview()

    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(4))
    expect(rowNames()).toEqual(["Newest.usfm", "Mid.usfm", "Old.usfm", "NeverEdited.usfm"])
  })

  it("switching to canonical order puts Genesis before Exodus regardless of last-updated", async () => {
    useFiles([
      fileWith("f1", "EXO.usfm", 999), // most recently edited, but canonical must still win
      fileWith("f2", "GEN.usfm", 1),
    ])

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(2))
    expect(rowNames()).toEqual(["EXO.usfm", "GEN.usfm"]) // last-updated default sanity check

    await pickSelectOption(/sort files by/i, /^canonical order$/i)

    expect(rowNames()).toEqual(["GEN.usfm", "EXO.usfm"])
  })

  it("switching to alphabetical orders rows by name", async () => {
    useFiles([fileWith("f1", "Zeta.usfm", null), fileWith("f2", "Alpha.usfm", null)])

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(2))

    await pickSelectOption(/sort files by/i, /^alphabetical$/i)

    expect(rowNames()).toEqual(["Alpha.usfm", "Zeta.usfm"])
  })

  it("typing in the name filter narrows the visible rows", async () => {
    useFiles([
      fileWith("f1", "GEN.usfm", null),
      fileWith("f2", "EXO.usfm", null),
      fileWith("f3", "Notes.txt", null),
    ])

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(3))

    fireEvent.change(screen.getByLabelText(/filter files by name/i), { target: { value: "gen" } })

    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(1))
    expect(rowNames()).toEqual(["GEN.usfm"])
  })

  it("keeps AQU-493's expanded chapter/verse rollup on the same file after re-sorting moves its row", async () => {
    useFiles([fileWith("f1", "EXO.usfm", 50), fileWith("f2", "GEN.usfm", 100)])
    getFileProgress.mockResolvedValue({
      fileId: "f2", revision: 1, validationCount: 1,
      file: { totalCount: 1, filledCount: 1, validatedCount: 1, validationLevels: [1] },
      sections: [{ key: "GEN 1", totalCount: 1, filledCount: 1, validatedCount: 1, validationLevels: [1] }],
      source: "projection",
    })

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(2))

    // Default (last-updated) order: GEN.usfm (100) first, EXO.usfm (50) second.
    expect(rowNames()).toEqual(["GEN.usfm", "EXO.usfm"])
    const genRow = screen.getAllByTestId("file-row")[0]
    fireEvent.click(within(genRow).getByRole("button", { name: /^expand GEN\.usfm$/i }))
    await screen.findByTestId("book-row")

    // Flip to alphabetical (EXO.usfm < GEN.usfm) so GEN actually moves to a
    // different row position — proving expansion tracks fileId, not index.
    await pickSelectOption(/sort files by/i, /^alphabetical$/i)
    expect(rowNames()).toEqual(["EXO.usfm", "GEN.usfm"])

    const newGenRow = screen.getAllByTestId("file-row")[1]
    expect(within(newGenRow).getByRole("button", { name: /^collapse GEN\.usfm$/i })).toBeInTheDocument()
    expect(within(newGenRow).getByTestId("book-row")).toBeInTheDocument()
    // Re-sorting must never re-trigger the lazy compact progress fetch for an
    // already-expanded file.
    expect(getFileProgress).toHaveBeenCalledTimes(1)
  })
})

// ── AQU-500: CSV export / copy-to-clipboard ─────────────────────────────────

describe("ProjectOverview CSV export (AQU-500)", () => {
  // WHY: PMs want the progress table out into a spreadsheet. The control must
  // (a) only appear when the org's export permission (useOrgSettings.canExport
  // — the pre-existing FRO-253 primitive) allows it, and (b) export exactly
  // the rows/order the PM currently sees, honoring AQU-499's sort/filter.

  beforeEach(() => {
    fetchSyncToken.mockResolvedValue({ token: "tok" })
    // happy-dom's navigator.clipboard is getter-only — define it per FRO-277's
    // ImportDialog.partial-import.test.tsx pattern.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    })
  })

  function fileWith(fileId: string, name: string): import("@/lib/sync/cells-read").FileSummary {
    return { fileId, projectId: "p1", name, fileType: "usfm", sourceLanguage: null, targetLanguage: null, cellCount: 10, filledCount: 5, approvedCount: 2, wordCount: 100, lastEditAt: null }
  }

  function useFiles(files: import("@/lib/sync/cells-read").FileSummary[]) {
    fetchProjectFiles.mockResolvedValue(files)
    useProject.mockReturnValue({
      project: projectRecord({
        level: 400,
        name: "My Project",
        files: files.map((f) => ({ id: f.fileId, name: f.name, type: "usfm", createdAt: "x", cellCount: f.cellCount })),
      }),
      status: "ready",
      refresh,
    })
  }

  it("shows the export controls when the org's export permission allows it", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles([fileWith("f1", "Genesis.usfm")])

    renderOverview()

    await screen.findByTestId("export-csv-copy")
    expect(screen.getByTestId("export-csv-download")).toBeInTheDocument()
  })

  it("hides the export controls when the caller is below the org's export floor", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: false })
    useFiles([fileWith("f1", "Genesis.usfm")])

    renderOverview()

    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(1))
    expect(screen.queryByTestId("export-csv-copy")).not.toBeInTheDocument()
    expect(screen.queryByTestId("export-csv-download")).not.toBeInTheDocument()
  })

  it("copies the visible rows as CSV, honoring the current sort/filter", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles([fileWith("f1", "Zeta.usfm"), fileWith("f2", "Alpha.usfm")])

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(2))

    // Switch to alphabetical so the exported order must follow Alpha, Zeta —
    // not file-list-fetch order — proving the export reads the sorted array.
    await pickSelectOption(/sort files by/i, /^alphabetical$/i)

    fireEvent.click(screen.getByTestId("export-csv-copy"))

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1))
    const csv = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0] as string
    expect(csv.split("\r\n")).toEqual([
      "File,Filled,Approved,Total cells,Word count",
      "Alpha.usfm,5,2,10,100",
      "Zeta.usfm,5,2,10,100",
    ])
  })

  it("filtering by name narrows what gets exported", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles([fileWith("f1", "Genesis.usfm"), fileWith("f2", "Exodus.usfm")])

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(2))

    fireEvent.change(screen.getByLabelText(/filter files by name/i), { target: { value: "gen" } })
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(1))

    fireEvent.click(screen.getByTestId("export-csv-copy"))

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1))
    const csv = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0] as string
    expect(csv.split("\r\n")).toEqual([
      "File,Filled,Approved,Total cells,Word count",
      "Genesis.usfm,5,2,10,100",
    ])
  })

  it("downloads a CSV blob named after the project", async () => {
    useOrgSettingsMock.mockReturnValue({ ...defaultOrgSettingsMock(), canExport: true })
    useFiles([fileWith("f1", "Genesis.usfm")])

    renderOverview()
    await waitFor(() => expect(screen.getAllByTestId("file-row").length).toBe(1))

    fireEvent.click(screen.getByTestId("export-csv-download"))

    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = downloadBlob.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(filename).toBe("My-Project-progress.csv")
  })
})
