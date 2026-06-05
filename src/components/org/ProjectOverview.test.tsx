import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectOverview } from "./ProjectOverview"
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
const getPortfolio = vi.fn((_jwt: string, _orgId: number): Promise<PortfolioProject[]> => Promise.resolve([]))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: (jwt: string, orgId: number) => getPortfolio(jwt, orgId),
  // Real implementations — tests must not override these with wrong stubs
  audioPct: (p: { audioCells: number; totalCells: number }) => (p.totalCells > 0 ? p.audioCells / p.totalCells : 0),
  translatedPct: (p: { filledCells: number; totalCells: number }) => (p.totalCells > 0 ? p.filledCells / p.totalCells : 0),
  validatedPct: (p: { validatedCells: number; totalCells: number }) => (p.totalCells > 0 ? p.validatedCells / p.totalCells : 0),
  recordedMinutes: (p: { recordedMs: number }) => Math.round(p.recordedMs / 60000),
  deadlineStatus: () => null,
}))
vi.mock("@/lib/sync/cloud-projects", () => ({ setProjectDeadline: vi.fn() }))
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

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

/** Build a FileSummary stub for testing the file list. */
function fileSummary(i: number): import("@/lib/sync/cells-read").FileSummary {
  return { fileId: `f${i}`, projectId: "p1", name: `File${i}.usfm`, fileType: "usfm", sourceLanguage: null, targetLanguage: null, cellCount: 10, filledCount: 5, approvedCount: 2, wordCount: 100, lastEditAt: null }
}

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
    expect(screen.getAllByRole("listitem").length).toBe(12)

    // Clicking show-more reveals all 16 files
    const showMore = screen.getByRole("button", { name: /show all/i })
    fireEvent.click(showMore)

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(totalFiles))
    // Header should now say "(16)" not "top 12 of 16"
    expect(screen.queryByText(/top 12 of 16/)).not.toBeInTheDocument()
    expect(screen.getByText(/\(16\)/)).toBeInTheDocument()
  })
})

describe("ProjectOverview archive/restore", () => {
  it("owner sees Archive; clicking archives and returns to /projects", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    archiveProjectRemote.mockResolvedValue({ kind: "archived", archivedAt: "now", archivedBy: { id: 1, username: "wendi" } })
    renderOverview()

    const btn = await screen.findByRole("button", { name: "Archive" })
    fireEvent.click(btn)

    await waitFor(() => expect(archiveProjectRemote).toHaveBeenCalledWith("p1", "jwt"))
    expect(navigate).toHaveBeenCalledWith("/projects")
  })

  it("non-owner does not see the Archive button", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 100 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument()
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

  it("maintainer sees Download deliverable; clicking triggers the bundle download", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 600, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 0 }] }),
      status: "ready",
      refresh,
    })
    downloadProjectBundle.mockResolvedValue(undefined)
    renderOverview()

    const btn = await screen.findByRole("button", { name: "Download deliverable" })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(downloadProjectBundle).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", fileId: "f1" })),
    )
  })

  it("non-maintainer does not see Download deliverable", async () => {
    useProject.mockReturnValue({
      project: projectRecord({ level: 400, files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: "x", cellCount: 0 }] }),
      status: "ready",
      refresh,
    })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "Download deliverable" })).not.toBeInTheDocument()
  })
})

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
        audioCells: 0,    // no recordings at all → correct 0%
        recordedMs: 0,
        lastEditAt: Date.now(),
        deadlineAt: null,
      },
    ])

    renderOverview()

    // Progress section renders when totalCells > 0 — including the Audio bar.
    await waitFor(() => expect(screen.getAllByText("Audio").length).toBeGreaterThan(0))
    // All percentage labels are present; 0% appears for the audio bar.
    const pctLabels = screen.getAllByText(/^\d+%$/)
    expect(pctLabels.map((el) => el.textContent)).toContain("0%")
  })
})
