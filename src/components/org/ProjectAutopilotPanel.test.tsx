import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ProjectAutopilotPanel } from "./ProjectAutopilotPanel"
import type {
  ContextualOverview,
  ContextualRunActivity,
  ContextualRunActivityOptions,
  ContextualRunListOptions,
  ContextualRunPage,
  ContextualRunRecord,
  ProjectRunStartResult,
} from "@/lib/contextual/transport"

const fetchMock = vi.fn<(projectId: string) => Promise<ContextualOverview>>()
const startMock = vi.fn<(projectId: string) => Promise<ProjectRunStartResult>>()
const runsMock = vi.fn<(
  _projectId: string,
  _options?: ContextualRunListOptions,
) => Promise<ContextualRunPage>>(async () => ({
  available: true,
  runs: [],
  truncated: false,
  nextCursor: null,
}))
const activityMock = vi.fn<(
  _projectId: string,
  _runId: string,
  _options?: ContextualRunActivityOptions,
) => Promise<ContextualRunActivity>>(
  async () => ({ run: null, events: [], sceneBriefs: [], drafts: [], truncated: false }),
)
const commandMock = vi.fn<(
  _projectId: string,
  _runId: string,
  _command: string,
) => Promise<ContextualRunRecord | null>>(async () => null)
const retryMock = vi.fn<(_projectId: string, _fileId: string) => Promise<{ runId: string }>>(
  async () => ({ runId: "new-run" }),
)

vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualOverview: (projectId: string) => fetchMock(projectId),
  startProjectContextualRun: (projectId: string) => startMock(projectId),
  fetchContextualRuns: (projectId: string, options?: ContextualRunListOptions) => runsMock(projectId, options),
  fetchContextualRunActivity: (projectId: string, runId: string, options?: ContextualRunActivityOptions) => activityMock(projectId, runId, options),
  commandContextualRun: (projectId: string, runId: string, command: string) => commandMock(projectId, runId, command),
  startFileContextualRun: (projectId: string, fileId: string) => retryMock(projectId, fileId),
}))

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

function overview(patch: Partial<ContextualOverview> = {}): ContextualOverview {
  const files = patch.files ?? []
  return {
    available: true,
    files,
    activeRuns: 0,
    doneSpans: files.reduce((total, file) => total + file.doneSpans, 0),
    totalSpans: files.reduce((total, file) => total + file.totalSpans, 0),
    failedSpans: files.reduce((total, file) => total + file.failedSpans, 0),
    unitsSpent: 0,
    proposedDrafts: 0,
    appliedDrafts: 0,
    ...patch,
  }
}

function fileRow(patch: Partial<ContextualOverview["files"][number]> = {}) {
  return {
    fileId: "f1",
    runId: "r1",
    targetLang: "",
    status: "running",
    doneSpans: 3,
    totalSpans: 10,
    failedSpans: 0,
    unitsSpent: 51,
    proposedDrafts: 7,
    appliedDrafts: 2,
    updatedAt: "2026-08-02T00:00:00.000Z",
    lastError: null,
    ...patch,
  }
}

const fileNames = new Map([["f1", "MRK.usfm"], ["f2", "LUK.usfm"]])

function renderPanel(canStart = true) {
  return render(<ProjectAutopilotPanel projectId="p1" fileNames={fileNames} canStart={canStart} />)
}

beforeEach(() => {
  fetchMock.mockReset()
  startMock.mockReset()
  runsMock.mockReset()
  runsMock.mockResolvedValue({ available: true, runs: [], truncated: false, nextCursor: null })
  activityMock.mockReset()
  activityMock.mockResolvedValue({ run: null, events: [], sceneBriefs: [], drafts: [], truncated: false })
  commandMock.mockReset()
  commandMock.mockResolvedValue(null)
  retryMock.mockReset()
  retryMock.mockResolvedValue({ runId: "new-run" })
  startMock.mockResolvedValue({
    scope: "project",
    scopeGroup: "g1",
    started: [{ runId: "r9", fileId: "f2" }],
    skipped: [],
    totalCandidates: 1,
    deferred: { count: 0, reason: null },
    truncated: false,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ProjectAutopilotPanel", () => {
  it("disappears cleanly when the backend is unavailable", async () => {
    fetchMock.mockResolvedValue(overview({ available: false }))
    renderPanel()
    await waitFor(() => expect(screen.queryByTestId("project-autopilot-loading")).not.toBeInTheDocument())
    expect(screen.queryByTestId("project-autopilot-panel")).not.toBeInTheDocument()
  })

  it("drops the prior project's counts and open inspector when the keyed route scope changes", async () => {
    const runFor = (projectId: string, fileId: string): ContextualRunRecord => ({
      runId: `${projectId}-run`,
      fileId,
      status: "done",
      phase: null,
      spanLabel: null,
      done: 8,
      total: 8,
      failed: 0,
      unitsSpent: 4,
      callsSpent: 2,
      lastError: null,
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:01:00.000Z",
      activeDirections: [],
      proposedDrafts: projectId === "project-a" ? 9 : 1,
    })
    const runA = runFor("project-a", "file-a")
    const runB = runFor("project-b", "file-b")
    fetchMock.mockImplementation(async (projectId) => overview({
      files: [fileRow({
        fileId: projectId === "project-a" ? "file-a" : "file-b",
        runId: projectId === "project-a" ? runA.runId : runB.runId,
        status: "done",
        proposedDrafts: projectId === "project-a" ? 9 : 1,
      })],
      proposedDrafts: projectId === "project-a" ? 9 : 1,
    }))
    runsMock.mockImplementation(async (projectId) => ({
      available: true,
      runs: [projectId === "project-a" ? runA : runB],
      truncated: false,
      nextCursor: null,
    }))
    const names = new Map([["file-a", "A.usfm"], ["file-b", "B.usfm"]])
    const rendered = render(
      <ProjectAutopilotPanel key="project-a" projectId="project-a" fileNames={names} canStart />,
    )

    expect(await screen.findByRole("button", { name: "View 9 ready to review" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "View activity" }))
    expect((await screen.findAllByText("A.usfm")).length).toBeGreaterThan(0)

    // ProjectOverview keys this child by the route id. A param-only route
    // transition must therefore destroy every project-scoped Sheet/list/count.
    rendered.rerender(
      <ProjectAutopilotPanel key="project-b" projectId="project-b" fileNames={names} canStart />,
    )

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Autopilot activity" })).not.toBeInTheDocument())
    expect(screen.queryAllByText("A.usfm")).toHaveLength(0)
    expect(await screen.findByRole("button", { name: "View 1 ready to review" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "View activity" }))
    expect((await screen.findAllByText("B.usfm")).length).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith("project-b")
    expect(runsMock).toHaveBeenCalledWith("project-b", undefined)
  })

  it("keeps the default card compact and exposes only the three action counts", async () => {
    fetchMock.mockResolvedValue(overview({
      files: [fileRow({ status: "done", failedSpans: 2 })],
      proposedDrafts: 12,
      failedSpans: 2,
      readiness: {
        ready: false,
        blockingGaps: 1,
        items: [
          { id: "brief", label: "Brief", level: "missing", detail: "Missing" },
          { id: "terms", label: "Terms", level: "partial", detail: "Partial" },
          { id: "lang", label: "Languages", level: "ready", detail: "Ready" },
        ],
      },
    }))
    renderPanel()
    const panel = await screen.findByTestId("project-autopilot-panel")
    expect(screen.getByRole("button", { name: "View 12 ready to review" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View 2 needs attention" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View 2 context suggestions" })).toBeInTheDocument()
    expect(panel.querySelector("table")).toBeNull()
    expect(panel.querySelector('[role="list"]')).toBeNull()
    expect(screen.queryByText("MRK.usfm")).not.toBeInTheDocument()
  })

  it("uses truthful status precedence and never calls paused work drafting", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 1,
      proposedDrafts: 8,
      files: [
        fileRow({ status: "paused" }),
        fileRow({ fileId: "f2", runId: "r2", status: "failed", lastError: "Credits exhausted" }),
      ],
    }))
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0)
    expect(screen.getByText(/Open activity to see what happened/)).toBeInTheDocument()
    expect(screen.queryByText(/Credits exhausted/)).not.toBeInTheDocument()
    expect(screen.queryByText(/drafting/i)).not.toBeInTheDocument()
  })

  it("does not invent a failed passage for a run-level provider or configuration failure", async () => {
    fetchMock.mockResolvedValue(overview({
      files: [fileRow({
        status: "failed",
        doneSpans: 0,
        totalSpans: 0,
        failedSpans: 0,
        lastError: "provider_transport_error",
      })],
    }))
    renderPanel()

    expect(await screen.findByText(/1 issue needs attention/)).toBeInTheDocument()
    expect(screen.queryByText(/passage needs attention/)).not.toBeInTheDocument()
  })

  it("counts only genuinely working files when the legacy aggregate also includes parked work", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 3,
      files: [
        fileRow({ status: "running" }),
        fileRow({ fileId: "f2", runId: "r2", status: "parked", doneSpans: 10, totalSpans: 10 }),
      ],
    }))
    renderPanel()
    expect(await screen.findByText(/Working across 1 file/)).toBeInTheDocument()
    expect(screen.queryByText(/Working across 3 files/)).not.toBeInTheDocument()
  })

  it("aggregates lane progress while counting unique files and keeps an unsupported historic lane visible", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 2,
      files: [
        fileRow({ runId: "default-active", targetLang: "", status: "running", doneSpans: 3, totalSpans: 10 }),
        fileRow({ runId: "legacy-lane", targetLang: "fr", status: "pausing", doneSpans: 2, totalSpans: 10 }),
      ],
    }))
    runsMock.mockResolvedValue({
      available: true,
      truncated: false,
      nextCursor: null,
      runs: [
        {
          runId: "default-active",
          fileId: "f1",
          targetLang: "",
          status: "running",
          phase: null,
          spanLabel: null,
          done: 3,
          total: 10,
          failed: 0,
          unitsSpent: 0,
          callsSpent: 0,
          lastError: null,
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          activeDirections: [],
        },
        {
          runId: "legacy-lane",
          fileId: "f1",
          targetLang: "fr",
          status: "pausing",
          phase: null,
          spanLabel: null,
          done: 2,
          total: 10,
          failed: 0,
          unitsSpent: 0,
          callsSpent: 0,
          lastError: null,
          createdAt: "2026-08-02T00:01:00.000Z",
          updatedAt: "2026-08-02T00:01:00.000Z",
          activeDirections: [],
        },
      ],
    })
    renderPanel()

    const panel = await screen.findByTestId("project-autopilot-panel")
    expect(within(panel).getByText(/Working across 1 file.*5 of 20 passages complete/)).toBeInTheDocument()
    expect(within(panel).getByLabelText("5 of 20 passages complete")).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole("button", { name: "View activity" }))
    expect(await screen.findByText("Target: fr")).toBeInTheDocument()
  })

  it("does not hide older active work behind a newer terminal lane for the same file", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 1,
      files: [
        fileRow({
          runId: "older-default-active",
          targetLang: "",
          status: "running",
          doneSpans: 4,
          totalSpans: 10,
          updatedAt: "2026-08-02T00:00:00.000Z",
        }),
        fileRow({
          runId: "newer-legacy-terminal",
          targetLang: "fr",
          status: "terminated",
          doneSpans: 0,
          totalSpans: 0,
          updatedAt: "2026-08-02T00:01:00.000Z",
        }),
      ],
    }))
    renderPanel()

    expect(await screen.findByText(/Working across 1 file.*4 of 10 passages complete/)).toBeInTheDocument()
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument()
  })

  it("keeps an active run's status primary when an earlier passage failed", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 1,
      failedSpans: 1,
      files: [fileRow({ status: "running", failedSpans: 1, lastError: "One passage failed checks" })],
    }))
    renderPanel()
    const panel = await screen.findByTestId("project-autopilot-panel")

    expect(within(panel).getByText("Working")).toBeInTheDocument()
    expect(within(panel).getByRole("button", { name: "View 1 needs attention" })).toBeInTheDocument()
    expect(within(panel).queryByRole("button", { name: "Run Autopilot" })).not.toBeInTheDocument()
  })

  it("keeps executing sibling work primary when another file has terminally failed", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 1,
      files: [
        fileRow({ status: "running", doneSpans: 3, totalSpans: 10 }),
        fileRow({
          fileId: "f2",
          runId: "failed-sibling",
          status: "failed",
          doneSpans: 0,
          totalSpans: 0,
          failedSpans: 0,
          lastError: "provider_transport_error",
        }),
      ],
    }))
    renderPanel()
    const panel = await screen.findByTestId("project-autopilot-panel")

    expect(within(panel).getByText("Working")).toBeInTheDocument()
    expect(within(panel).getByText(/Working across 1 file.*3 of 10 passages complete/)).toBeInTheDocument()
    expect(within(panel).getByRole("button", { name: "View 1 needs attention" })).toBeInTheDocument()
  })

  it("surfaces an exhausted run as a startable terminal failure", async () => {
    fetchMock.mockResolvedValue(overview({
      failedSpans: 1,
      files: [fileRow({ status: "failed", doneSpans: 9, totalSpans: 10, failedSpans: 1, lastError: "One passage failed checks" })],
    }))
    renderPanel()
    const panel = await screen.findByTestId("project-autopilot-panel")

    expect(within(panel).getAllByText("Needs attention").length).toBeGreaterThan(0)
    expect(within(panel).getByRole("button", { name: "View 1 needs attention" })).toBeInTheDocument()
    expect(within(panel).getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()
  })

  it("shows a determinate progress bar only when active total is known", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 1,
      doneSpans: 3,
      totalSpans: 10,
      files: [fileRow()],
    }))
    renderPanel()
    await screen.findByText("Working")
    expect(screen.getByLabelText("3 of 10 passages complete")).toBeInTheDocument()
  })

  it("stays indeterminate while any active sibling is still being segmented", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 2,
      doneSpans: 3,
      totalSpans: 10,
      files: [
        fileRow({ fileId: "f1", doneSpans: 3, totalSpans: 10 }),
        fileRow({ fileId: "f2", runId: "r2", doneSpans: 0, totalSpans: 0 }),
      ],
    }))
    renderPanel()

    expect(await screen.findByText(/Working across 2 files.*scanning passages/)).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.queryByText(/3 of 10 passages complete/)).not.toBeInTheDocument()
  })

  it("uses the project aggregate after sibling runs complete instead of shrinking the denominator", async () => {
    fetchMock.mockResolvedValue(overview({
      activeRuns: 1,
      doneSpans: 11,
      totalSpans: 18,
      files: [
        fileRow({ fileId: "f1", doneSpans: 3, totalSpans: 10 }),
        fileRow({ fileId: "f2", runId: "r2", status: "done", doneSpans: 8, totalSpans: 8 }),
      ],
    }))
    renderPanel()

    expect(await screen.findByText(/11 of 18 passages complete across the project’s latest runs/)).toBeInTheDocument()
    expect(screen.getByLabelText("11 of 18 passages complete")).toBeInTheDocument()
  })

  it("keeps the next project batch reachable after an exhausted run parks", async () => {
    fetchMock.mockResolvedValue(overview({
      files: [fileRow({ status: "parked", doneSpans: 10, totalSpans: 10, failedSpans: 0 })],
    }))
    renderPanel()
    const panel = await screen.findByTestId("project-autopilot-panel")

    expect(within(panel).getByText("Idle")).toBeInTheDocument()
    expect(within(panel).getByText(/No more work is queued/)).toBeInTheDocument()
    expect(within(panel).getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()
  })

  it("explains the never-run state while keeping it ready to act", async () => {
    fetchMock.mockResolvedValue(overview())
    renderPanel()
    await screen.findByText("Not started")
    expect(screen.getByText(/Ready to run.*hasn’t run/i)).toBeInTheDocument()
  })

  it("acknowledges start immediately, then summarizes started and skipped files", async () => {
    fetchMock.mockResolvedValue(overview())
    let resolveStart!: (value: ProjectRunStartResult) => void
    startMock.mockReturnValue(new Promise((resolve) => { resolveStart = resolve }))
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")

    fireEvent.click(screen.getByRole("button", { name: "Run Autopilot" }))
    expect(screen.getByRole("status")).toHaveTextContent("Starting Autopilot…")
    expect(screen.getByRole("button", { name: "Run Autopilot" })).toBeDisabled()

    await act(async () => resolveStart({
      scope: "project",
      scopeGroup: "g1",
      started: [{ runId: "r1", fileId: "f1" }],
      skipped: [{ fileId: "f2", reason: "already running" }],
      totalCandidates: 1,
      deferred: { count: 0, reason: null },
      truncated: false,
    }))
    expect(await screen.findByText(/1 file started · 1 skipped/)).toBeInTheDocument()
    expect(screen.getByText(/1 file is already running/)).toBeInTheDocument()
    expect(screen.getByText(/Draft suggestions stay in review/)).toBeInTheDocument()
  })

  it("explains mixed no-op skip outcomes without exposing backend reason codes", async () => {
    fetchMock.mockResolvedValue(overview())
    startMock.mockResolvedValue({
      scope: "project",
      scopeGroup: "g-skipped",
      started: [],
      skipped: [
        { fileId: "f1", reason: "start_failed" },
        { fileId: "f2", reason: "idle run owns file; review or stop it before rerunning" },
        { fileId: "f3", reason: "work queued" },
        { fileId: "f4", reason: "paused" },
        { fileId: "f5", reason: "pause pending" },
      ],
      totalCandidates: 5,
      deferred: { count: 0, reason: null },
      truncated: false,
    })
    renderPanel()

    fireEvent.click(await screen.findByRole("button", { name: "Run Autopilot" }))

    const summary = await screen.findByText(/No files started · 5 skipped/)
    expect(summary).toHaveTextContent("1 file couldn’t start; open activity for details")
    expect(summary).toHaveTextContent("1 file has an idle run; review its drafts or stop it before rerunning")
    expect(summary).toHaveTextContent("1 file still has queued work")
    expect(summary).toHaveTextContent("1 file is paused")
    expect(summary).toHaveTextContent("1 file is finishing a pause")
    expect(summary).not.toHaveTextContent("start_failed")
    expect(summary).not.toHaveTextContent("pause pending")
  })

  it("discloses files deferred by the project batch limit and how to continue", async () => {
    fetchMock.mockResolvedValue(overview())
    startMock.mockResolvedValue({
      scope: "project",
      scopeGroup: "g-batch",
      started: Array.from({ length: 24 }, (_, index) => ({ runId: `run-${index}`, fileId: `file-${index}` })),
      skipped: [],
      totalCandidates: 25,
      deferred: { count: 1, reason: "batch_limit" },
      truncated: true,
    })
    renderPanel()

    fireEvent.click(await screen.findByRole("button", { name: "Run Autopilot" }))

    expect(await screen.findByText(/24 files started · 1 deferred to the next batch/)).toBeInTheDocument()
    expect(screen.getByText(/Run Autopilot again after this batch becomes idle/)).toBeInTheDocument()
  })

  it("hides the guarded start control below the contributor floor", async () => {
    fetchMock.mockResolvedValue(overview())
    renderPanel(false)
    await screen.findByTestId("project-autopilot-panel")
    expect(screen.queryByRole("button", { name: "Run Autopilot" })).not.toBeInTheDocument()
  })

  it("polls running work on the observable cadence and stops after parking", async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(overview({ activeRuns: 1, files: [fileRow()] }))
      .mockResolvedValueOnce(overview({ files: [fileRow({ status: "parked", doneSpans: 10 })], proposedDrafts: 4 }))
    renderPanel()
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Idle")).toBeInTheDocument()
    expect(screen.getByText(/No more work is queued/)).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(8_000); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("keeps reconciling a capped parked run while passages remain queued", async () => {
    vi.useFakeTimers()
    const queued = overview({
      activeRuns: 1,
      files: [fileRow({ status: "parked", doneSpans: 3, failedSpans: 1, totalSpans: 10 })],
    })
    const resumed = overview({
      activeRuns: 1,
      files: [fileRow({ status: "running", doneSpans: 4, failedSpans: 1, totalSpans: 10 })],
    })
    fetchMock.mockResolvedValueOnce(queued).mockResolvedValue(resumed)
    renderPanel()
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText("Queued")).toBeInTheDocument()
    expect(screen.getByText(/6 passages are queued.*continue in the background/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.getByText(/Working across 1 file.*4 of 10 passages complete/)).toBeInTheDocument()
  })

  it("retains the last good snapshot and marks it stale when refresh fails", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(overview({ activeRuns: 1, files: [fileRow()] })).mockRejectedValueOnce(new Error("offline"))
    renderPanel()
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve() })
    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.getByText(/Refresh failed.*snapshot checked/)).toBeInTheDocument()
  })

  it("keeps a recovery card visible when the first status request fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    renderPanel()
    expect((await screen.findAllByText("Needs attention")).length).toBeGreaterThan(0)
    expect(screen.getByText(/status couldn’t be loaded/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run Autopilot" })).not.toBeInTheDocument()
  })

  it("distinguishes a completed run from a project that has never run", async () => {
    fetchMock.mockResolvedValue(overview({ files: [fileRow({ status: "done", proposedDrafts: 0 })] }))
    renderPanel()
    expect(await screen.findByText("Complete")).toBeInTheDocument()
    expect(screen.queryByText("Not started")).not.toBeInTheDocument()
  })

  it("refreshes an idle overview immediately after Stop succeeds in the inspector", async () => {
    const parkedFile = fileRow({ status: "parked", doneSpans: 10, totalSpans: 10, proposedDrafts: 0, appliedDrafts: 0 })
    const stoppedFile = { ...parkedFile, status: "terminated" }
    fetchMock
      .mockResolvedValueOnce(overview({ files: [parkedFile] }))
      .mockResolvedValue(overview({ files: [stoppedFile] }))

    let currentRun: ContextualRunRecord = {
      runId: parkedFile.runId,
      fileId: parkedFile.fileId,
      status: parkedFile.status,
      phase: null,
      spanLabel: null,
      done: parkedFile.doneSpans,
      total: parkedFile.totalSpans,
      failed: parkedFile.failedSpans,
      unitsSpent: parkedFile.unitsSpent,
      callsSpent: 2,
      lastError: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: parkedFile.updatedAt,
      activeDirections: [],
      proposedDrafts: 0,
    }
    runsMock.mockImplementation(async () => ({
      available: true,
      runs: [currentRun],
      truncated: false,
      nextCursor: null,
    }))
    activityMock.mockImplementation(async () => ({
      run: currentRun,
      events: [],
      sceneBriefs: [],
      drafts: [],
      truncated: false,
    }))
    commandMock.mockImplementation(async () => {
      currentRun = { ...currentRun, status: "terminated" }
      return currentRun
    })

    renderPanel()
    const panel = await screen.findByTestId("project-autopilot-panel")
    expect(within(panel).getByText("Idle")).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole("button", { name: "View activity" }))
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }))

    await waitFor(() => expect(commandMock).toHaveBeenCalledWith("p1", "r1", "terminate"))
    await waitFor(() => expect(within(panel).getByText("Stopped")).toBeInTheDocument())
    expect(within(panel).getByText("The latest Autopilot run was stopped.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(within(panel).getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()
  })
})
