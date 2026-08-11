import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AutopilotActivityInspector } from "./AutopilotActivityInspector"
import type {
  ContextualOverview,
  ContextualRunActivity,
  ContextualRunActivityOptions,
  ContextualRunListOptions,
  ContextualRunPage,
  ContextualRunRecord,
} from "@/lib/contextual/transport"

const RUN_ID = "01920000-0000-7000-8000-000000000001"

const run: ContextualRunRecord = {
  runId: RUN_ID,
  fileId: "file-1",
  status: "running",
  phase: "Checking…",
  spanLabel: "LUK 1:1–1:8",
  done: 3,
  total: 10,
  failed: 0,
  unitsSpent: 42,
  callsSpent: 7,
  lastError: null,
  createdAt: "2026-08-11T10:00:00.000Z",
  updatedAt: "2026-08-11T10:02:00.000Z",
  activeDirections: [],
}

const activity: ContextualRunActivity = {
  run,
  events: [{
    id: "event-1",
    runId: RUN_ID,
    projectId: "p1",
    fileId: "file-1",
    kind: "drafts_staged",
    spanId: "span-1",
    spanLabel: "LUK 1:1–1:8",
    summary: "Staged 3 drafts for review.",
    details: { staged: 3, traceId: "trace-1", token: "must-not-copy" },
    createdAt: "2026-08-11T10:01:00.000Z",
  }],
  sceneBriefs: [{
    id: "brief-1",
    status: "proposed",
    startCellId: "c1",
    endCellId: "c3",
    l1Summary: "A teacher addresses a crowd.",
    construal: "The teacher warns the crowd.",
    ambiguityRegister: [{ id: "a1", question: "Is the warning ironic?" }],
  }],
  drafts: [{
    id: "draft-1",
    runId: RUN_ID,
    fileId: "file-1",
    cellId: "c2",
    text: "Draft text",
    status: "proposed",
    provenance: { runId: RUN_ID, sceneBriefId: "brief-1" },
  }],
  truncated: false,
}

function runPage(runs: ContextualRunRecord[], truncated = false): ContextualRunPage {
  return {
    available: true,
    runs,
    truncated,
    nextCursor: truncated
      ? { createdAt: "2026-08-11T09:00:00.000Z", runId: "older-run" }
      : null,
  }
}

const runsMock = vi.fn(async (
  _projectId: string,
  _options?: ContextualRunListOptions,
): Promise<ContextualRunPage> => runPage([run]))
const activityMock = vi.fn(async (
  _projectId: string,
  _runId: string,
  _options?: ContextualRunActivityOptions,
): Promise<ContextualRunActivity> => activity)
const commandMock = vi.fn<(
  _projectId: string,
  _runId: string,
  _command: string,
) => Promise<ContextualRunRecord>>(async () => ({ ...run, status: "paused" }))
const retryMock = vi.fn<(_projectId: string, _fileId: string) => Promise<{ runId: string }>>(
  async () => ({ runId: "new-run" }),
)

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualRuns: (projectId: string, options?: ContextualRunListOptions) => runsMock(projectId, options),
  fetchContextualRunActivity: (
    projectId: string,
    runId: string,
    options?: ContextualRunActivityOptions,
  ) => activityMock(projectId, runId, options),
  commandContextualRun: (projectId: string, runId: string, command: string) => commandMock(projectId, runId, command),
  startFileContextualRun: (projectId: string, fileId: string) => retryMock(projectId, fileId),
}))

beforeEach(() => {
  runsMock.mockReset()
  runsMock.mockResolvedValue(runPage([run]))
  activityMock.mockReset()
  activityMock.mockResolvedValue(activity)
  commandMock.mockReset()
  commandMock.mockResolvedValue({ ...run, status: "paused" })
  retryMock.mockReset()
  retryMock.mockResolvedValue({ runId: "new-run" })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderInspector(props: Partial<React.ComponentProps<typeof AutopilotActivityInspector>> = {}) {
  return render(
    <AutopilotActivityInspector
      projectId="p1"
      open
      onOpenChange={vi.fn()}
      fileNames={new Map([["file-1", "LUK.usfm"]])}
      canControl
      {...props}
    />,
  )
}

describe("AutopilotActivityInspector", () => {
  it("shows a full accessible Sheet with durable event summaries and run progress", async () => {
    renderInspector()
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Autopilot activity")
    expect(screen.getByText(/evidence behind each step/i)).toBeInTheDocument()
    expect(await screen.findByText("Staged 3 drafts for review.")).toBeInTheDocument()
    expect(screen.getByRole("log", { name: "Autopilot step history" })).toHaveAttribute("aria-live", "off")
    expect(screen.getByLabelText("3 of 10 passages complete")).toBeInTheDocument()
    expect(screen.getByText(/7 calls/)).toBeInTheDocument()
    expect(screen.getByText(/42 units/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Run details/ }))
    expect(screen.getByText("Project default")).toBeInTheDocument()
  })

  it("keeps hydrated history non-live and announces only a newly observed step", async () => {
    const newEvent = {
      ...activity.events[0],
      id: "event-2",
      summary: "Finished checking the next passage.",
      createdAt: "2026-08-11T10:03:00.000Z",
    }
    activityMock
      .mockResolvedValueOnce(activity)
      .mockResolvedValue({ ...activity, events: [...activity.events, newEvent] })
    renderInspector()

    expect(await screen.findByText("Staged 3 drafts for review.")).toBeInTheDocument()
    const announcement = screen.getByTestId("autopilot-latest-step-announcement")
    expect(announcement).toBeEmptyDOMElement()
    expect(screen.getByRole("log", { name: "Autopilot step history" })).toHaveAttribute("aria-live", "off")

    fireEvent.click(screen.getByRole("button", { name: "Pause" }))

    expect(await screen.findByText("Autopilot update: Finished checking the next passage.")).toBeInTheDocument()
    expect(announcement).toHaveTextContent("Finished checking the next passage.")
  })

  it("opens failed details and offers a truthful new-run retry", async () => {
    const failed = { ...run, status: "failed", lastError: "Agent credit cap reached." }
    runsMock.mockResolvedValueOnce(runPage([failed]))
    activityMock.mockResolvedValueOnce({ ...activity, run: failed })
    renderInspector({ initialSection: "attention" })
    expect(await screen.findByText("Agent credit cap reached.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()
    expect(screen.getByText("Model calls")).toBeInTheDocument()
  })

  it("shows a nonterminal passage error without mislabelling the active run or offering a conflicting retry", async () => {
    const activeWithError = {
      ...run,
      status: "running",
      failed: 1,
      lastError: "One earlier passage failed checks.",
    }
    runsMock.mockResolvedValueOnce(runPage([activeWithError]))
    activityMock.mockResolvedValueOnce({ ...activity, run: activeWithError })
    renderInspector({ initialSection: "attention" })

    expect(await screen.findByText("One earlier passage failed checks.")).toBeInTheDocument()
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run Autopilot" })).not.toBeInTheDocument()
  })

  it("keeps a parked run idle when it retains a passage error", async () => {
    const parkedWithError = {
      ...run,
      status: "parked",
      done: 9,
      failed: 1,
      lastError: "The final passage needs attention.",
    }
    runsMock.mockResolvedValueOnce(runPage([parkedWithError]))
    activityMock.mockResolvedValueOnce({ ...activity, run: parkedWithError })
    renderInspector({ initialSection: "attention" })

    expect(await screen.findByText("The final passage needs attention.")).toBeInTheDocument()
    expect(screen.getAllByText("Idle").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run Autopilot" })).not.toBeInTheDocument()
  })

  it("distinguishes a capped parked run with queued work from an exhausted idle run", async () => {
    const queued = { ...run, status: "parked", done: 3, failed: 1, total: 10 }
    runsMock.mockResolvedValueOnce(runPage([queued]))
    activityMock.mockResolvedValueOnce({ ...activity, run: queued })
    renderInspector()

    expect((await screen.findAllByText("Queued")).length).toBeGreaterThan(0)
    expect(screen.getByText(/6 passages remain queued.*continue in the background/)).toBeInTheDocument()
    expect(screen.queryByText(/no more work is queued/i)).not.toBeInTheDocument()
  })

  it("progressively reveals drafts, construal, L1 summary, ambiguities, and provenance", async () => {
    renderInspector({ initialSection: "review" })
    expect(await screen.findByText("Draft text")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Review in editor: cell c2" })).toHaveAttribute(
      "href",
      "/project/p1/editor/file/file-1?cellId=c2&lane=",
    )
    expect(screen.getByText(/sceneBriefId/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Context/ }))
    expect(screen.getByText("A teacher addresses a crowd.")).toBeInTheDocument()
    expect(screen.getByText("The teacher warns the crowd.")).toBeInTheDocument()
    expect(screen.getByText("Is the warning ironic?")).toBeInTheDocument()
  })

  it("copies sanitized run metadata and events from technical evidence", async () => {
    const writeText = vi.fn<(_value: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    renderInspector()
    await screen.findByText("Staged 3 drafts for review.")
    fireEvent.click(screen.getByRole("button", { name: /Technical & evidence/ }))
    fireEvent.click(screen.getByRole("button", { name: "Copy activity log" }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain("drafts_staged")
    expect(copied).toContain("[redacted]")
    expect(copied).not.toContain("must-not-copy")
  })

  it("degrades gracefully when historic events were not recorded", async () => {
    activityMock.mockResolvedValueOnce({ run, events: [], sceneBriefs: [], drafts: [], truncated: false })
    renderInspector()
    expect(await screen.findByText(/Detailed step history wasn't recorded/)).toBeInTheDocument()
  })

  it("selects and marks the run that owns the project review backlog", async () => {
    const noReview = { ...run, runId: "run-without-review", fileId: "file-1", status: "done", proposedDrafts: 0 }
    const withReview = { ...run, runId: "run-with-review", fileId: "file-2", status: "done", proposedDrafts: 2 }
    const proposed = { ...activity.drafts[0], id: "draft-proposed", runId: withReview.runId, text: "Waiting draft", status: "proposed" }
    const applied = { ...activity.drafts[0], id: "draft-applied", runId: withReview.runId, text: "Previously applied", status: "applied" }
    runsMock.mockResolvedValue(runPage([noReview, withReview]))
    activityMock.mockImplementation(async (_projectId, runId) => ({
      ...activity,
      run: runId === withReview.runId ? withReview : noReview,
      drafts: runId === withReview.runId ? [proposed, applied] : [],
    }))
    const overview: ContextualOverview = {
      available: true,
      files: [],
      activeRuns: 0,
      doneSpans: 0,
      totalSpans: 0,
      failedSpans: 0,
      unitsSpent: 0,
      proposedDrafts: 2,
      appliedDrafts: 1,
    }

    renderInspector({
      initialSection: "review",
      overview,
      fileNames: new Map([["file-1", "LUK.usfm"], ["file-2", "MRK.usfm"]]),
    })

    expect(await screen.findByText(/2 drafts are ready across this project/)).toBeInTheDocument()
    const reviewRun = screen.getByRole("button", { name: /MRK\.usfm.*2 ready to review/i })
    expect(reviewRun).toHaveAttribute("aria-pressed", "true")
    expect(await screen.findByText("Waiting draft")).toBeInTheDocument()
    expect(screen.queryByText("Previously applied")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Draft history/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Open Activity to inspect non-proposed draft history/)).toBeInTheDocument()
  })

  it("pages past 50 recent runs to the review owner and shows returned drafts against the authoritative total", async () => {
    const recentRuns = Array.from({ length: 50 }, (_, index) => ({
      ...run,
      runId: `recent-${index}`,
      status: "done",
      proposedDrafts: 0,
      createdAt: `2026-08-11T10:${String(59 - index).padStart(2, "0")}:00.000Z`,
    }))
    const reviewOwner = {
      ...run,
      runId: "historical-review-owner",
      fileId: "file-review",
      status: "done",
      proposedDrafts: 700,
      createdAt: "2026-08-10T10:00:00.000Z",
    }
    const nextCursor = { createdAt: "2026-08-11T09:00:00.000Z", runId: "older-run" }
    runsMock.mockImplementation(async (_projectId, options) => options?.proposedOnly
      ? runPage([reviewOwner])
      : { ...runPage(recentRuns, true), nextCursor })
    const draftCursor = { createdAt: "2026-08-10T09:00:00.000Z", draftId: "returned-proposed" }
    activityMock.mockImplementation(async (_projectId, runId, options) => ({
      ...activity,
      run: runId === reviewOwner.runId ? reviewOwner : recentRuns[0],
      drafts: runId === reviewOwner.runId
        ? options?.draftCursor
          ? [{ ...activity.drafts[0], id: "second-proposed", status: "proposed", text: "Second proposed draft" }]
          : [
              { ...activity.drafts[0], id: "returned-proposed", status: "proposed", text: "Returned proposed draft" },
              { ...activity.drafts[0], id: "returned-applied", status: "applied", text: "Returned applied history" },
            ]
        : [],
      draftCounts: runId === reviewOwner.runId
        ? { proposed: 700, applied: 12, rejected: 3, superseded: 1 }
        : { proposed: 0, applied: 0, rejected: 0, superseded: 0 },
      draftNextCursor: runId === reviewOwner.runId && !options?.draftCursor
        ? draftCursor
        : null,
      truncated: runId === reviewOwner.runId,
      truncatedCollections: {
        events: false,
        sceneBriefs: false,
        drafts: runId === reviewOwner.runId,
      },
    }))

    renderInspector({
      initialSection: "review",
      overview: {
        available: true,
        files: [],
        activeRuns: 0,
        doneSpans: 0,
        totalSpans: 0,
        failedSpans: 0,
        unitsSpent: 0,
        proposedDrafts: 700,
        appliedDrafts: 12,
      },
      fileNames: new Map([["file-review", "REV.usfm"]]),
    })

    const owningRun = await screen.findByRole("button", { name: /REV\.usfm.*700 ready to review/i })
    expect(owningRun).toHaveAttribute("aria-pressed", "true")
    expect(runsMock).toHaveBeenCalledWith("p1", { proposedOnly: true })
    expect(await screen.findByText("Returned proposed draft")).toBeInTheDocument()
    expect(screen.queryByText("Returned applied history")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Ready to review.*1 of 700/i })).toBeInTheDocument()
    expect(activityMock).toHaveBeenCalledWith(
      "p1",
      reviewOwner.runId,
      expect.objectContaining({ draftStatus: "proposed", draftLimit: 50 }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Load more ready-to-review drafts" }))
    expect(await screen.findByText("Second proposed draft")).toBeInTheDocument()
    expect(screen.getAllByText(/^(Second|Returned) proposed draft$/).map((item) => item.textContent)).toEqual([
      "Second proposed draft",
      "Returned proposed draft",
    ])
    expect(screen.getByRole("button", { name: /Ready to review.*2 of 700/i })).toBeInTheDocument()
    expect(activityMock).toHaveBeenCalledWith(
      "p1",
      reviewOwner.runId,
      expect.objectContaining({ draftStatus: "proposed", draftLimit: 50, draftCursor }),
    )
  })

  it("preserves loaded older draft evidence when the active-run poll refreshes the first page", async () => {
    const active = { ...run, proposedDrafts: 3 }
    const draftCursor = { createdAt: "2026-08-10T09:00:00.000Z", draftId: "draft-newest" }
    let poll: (() => void) | null = null
    const realSetInterval = globalThis.setInterval
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ...call: Parameters<typeof setInterval>
    ) => {
      const [handler, delay] = call
      if (delay === 4_000 && typeof handler === "function") {
        poll = handler
        return 99 as unknown as ReturnType<typeof setInterval>
      }
      return realSetInterval(...call)
    }) as typeof setInterval)
    let firstPage = 0
    runsMock.mockResolvedValue(runPage([active]))
    activityMock.mockImplementation(async (_projectId, _runId, options) => {
      if (options?.draftCursor) {
        return {
          ...activity,
          run: active,
          drafts: [{ ...activity.drafts[0], id: "draft-older", text: "Older loaded evidence" }],
          draftCounts: { proposed: 3, applied: 0, rejected: 0, superseded: 0 },
          draftNextCursor: null,
        }
      }
      firstPage += 1
      return {
        ...activity,
        run: active,
        drafts: firstPage === 1
          ? [{ ...activity.drafts[0], id: "draft-newest", text: "Newest evidence" }]
          : [
            { ...activity.drafts[0], id: "draft-newest", text: "Newest evidence refreshed" },
            { ...activity.drafts[0], id: "draft-new", text: "New evidence from polling" },
          ],
        draftCounts: { proposed: 3, applied: 0, rejected: 0, superseded: 0 },
        draftNextCursor: draftCursor,
        truncated: true,
        truncatedCollections: { events: false, sceneBriefs: false, drafts: true },
      }
    })

    try {
      renderInspector({ initialSection: "review", fallbackRun: active })
      expect(await screen.findByText("Newest evidence")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Load more ready-to-review drafts" }))
      expect(await screen.findByText("Older loaded evidence")).toBeInTheDocument()
      expect(poll).toBeTypeOf("function")

      // Invoke the registered active-run poll directly: correctness waits on
      // its observable response, never on elapsed wall-clock time.
      await act(async () => poll?.())

      expect(await screen.findByText("New evidence from polling")).toBeInTheDocument()
      expect(screen.getByText("Older loaded evidence")).toBeInTheDocument()
      expect(screen.getByText("Newest evidence refreshed")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Load more ready-to-review drafts" })).not.toBeInTheDocument()
    } finally {
      intervalSpy.mockRestore()
    }
  })

  it("Refresh reconciles evidence for an idle run that does not poll", async () => {
    const idle = { ...run, status: "parked", done: 10, total: 10, proposedDrafts: 1 }
    const refreshed = { ...idle, proposedDrafts: 2, updatedAt: "2026-08-11T10:05:00.000Z" }
    runsMock.mockResolvedValueOnce(runPage([idle])).mockResolvedValue(runPage([refreshed]))
    activityMock
      .mockResolvedValueOnce({
        ...activity,
        run: idle,
        drafts: [{ ...activity.drafts[0], id: "draft-before", text: "Evidence before refresh" }],
        draftCounts: { proposed: 1, applied: 0, rejected: 0, superseded: 0 },
      })
      .mockResolvedValue({
        ...activity,
        run: refreshed,
        drafts: [
          { ...activity.drafts[0], id: "draft-before", text: "Evidence before refresh" },
          { ...activity.drafts[0], id: "draft-after", text: "Evidence added by a teammate" },
        ],
        draftCounts: { proposed: 2, applied: 0, rejected: 0, superseded: 0 },
      })

    renderInspector({ initialSection: "review", fallbackRun: idle })
    expect(await screen.findByText("Evidence before refresh")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    expect(await screen.findByText("Evidence added by a teammate")).toBeInTheDocument()
    expect(activityMock).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("button", { name: /Ready to review.*2/i })).toBeInTheDocument()
  })

  it("keeps a retry-selected run selected even when the Sheet opened with an older focus run", async () => {
    const failed = { ...run, runId: "failed-run", status: "failed", lastError: "Previous run failed." }
    const restarted = { ...run, runId: "new-run", status: "running", lastError: null }
    runsMock.mockResolvedValue(runPage([failed, restarted]))
    activityMock.mockImplementation(async (_projectId, runId) => ({
      ...activity,
      run: runId === restarted.runId ? restarted : failed,
    }))
    const { rerender } = renderInspector({
      focusRunId: failed.runId,
      focusFileId: failed.fileId,
      fallbackRun: failed,
    })

    fireEvent.click(await screen.findByRole("button", { name: "Run Autopilot" }))
    await vi.waitFor(() => expect(activityMock).toHaveBeenCalledWith(
      "p1",
      restarted.runId,
      expect.objectContaining({ draftLimit: 50 }),
    ))
    // Mirrors the editor parent refreshing its fallback snapshot after the
    // mutation while focusRunId still points at the failed run.
    rerender(
      <AutopilotActivityInspector
        projectId="p1"
        open
        onOpenChange={vi.fn()}
        fileNames={new Map([["file-1", "LUK.usfm"]])}
        focusRunId={failed.runId}
        focusFileId={failed.fileId}
        fallbackRun={{ ...failed, updatedAt: "2026-08-11T10:03:00.000Z" }}
      />,
    )

    const selected = screen.getAllByRole("button").find((button) => button.getAttribute("aria-pressed") === "true")
    expect(selected).toHaveTextContent("Working")
    expect(selected).not.toHaveTextContent("Needs attention")
  })

  it("drops an older-draft response after the user selects a different run", async () => {
    const firstRun = { ...run, runId: "run-a", fileId: "file-a", status: "done", proposedDrafts: 2 }
    const secondRun = { ...run, runId: "run-b", fileId: "file-b", status: "done", proposedDrafts: 1 }
    const draftCursor = { createdAt: "2026-08-10T09:00:00.000Z", draftId: "draft-a" }
    let resolveOlder!: (value: ContextualRunActivity) => void
    runsMock.mockResolvedValue(runPage([firstRun, secondRun]))
    activityMock.mockImplementation(async (_projectId, runId, options) => {
      if (runId === secondRun.runId) {
        return {
          ...activity,
          run: secondRun,
          events: [{ ...activity.events[0], id: "event-b", runId, summary: "Second run activity." }],
          drafts: [{ ...activity.drafts[0], id: "draft-b", runId, text: "Second run draft" }],
          draftCounts: { proposed: 1, applied: 0, rejected: 0, superseded: 0 },
          draftNextCursor: null,
        }
      }
      if (options?.draftCursor) {
        return new Promise((resolve) => { resolveOlder = resolve })
      }
      return {
        ...activity,
        run: firstRun,
        drafts: [{ ...activity.drafts[0], id: "draft-a", runId, text: "Newest first-run draft" }],
        draftCounts: { proposed: 2, applied: 0, rejected: 0, superseded: 0 },
        draftNextCursor: draftCursor,
        truncated: true,
        truncatedCollections: { events: false, sceneBriefs: false, drafts: true },
      }
    })

    renderInspector({
      initialSection: "review",
      fileNames: new Map([["file-a", "A.usfm"], ["file-b", "B.usfm"]]),
    })

    fireEvent.click(await screen.findByRole("button", { name: "Load more ready-to-review drafts" }))
    await vi.waitFor(() => expect(activityMock).toHaveBeenCalledWith(
      "p1",
      firstRun.runId,
      expect.objectContaining({ draftCursor }),
    ))
    fireEvent.click(screen.getByRole("button", { name: /B\.usfm.*1 ready to review/i }))
    expect(await screen.findByText("Second run activity.")).toBeInTheDocument()

    await act(async () => resolveOlder({
      ...activity,
      run: firstRun,
      drafts: [{ ...activity.drafts[0], id: "stale-older", text: "Stale older first-run draft" }],
      draftCounts: { proposed: 2, applied: 0, rejected: 0, superseded: 0 },
      draftNextCursor: null,
    }))
    expect(screen.queryByText("Stale older first-run draft")).not.toBeInTheDocument()
    expect(screen.getByText("Second run activity.")).toBeInTheDocument()
  })

  it("offers an explicit cursor action when older run history is available", async () => {
    runsMock.mockResolvedValue(runPage([run], true))
    renderInspector()
    expect(await screen.findByRole("button", { name: "Load older runs" })).toBeInTheDocument()
  })

  it("preserves loaded older run history when active polling refreshes the first page", async () => {
    const active = { ...run, done: 1, total: 10 }
    const older = {
      ...run,
      runId: "older-run",
      fileId: "file-old",
      status: "done",
      done: 8,
      total: 8,
    }
    const firstCursor = { createdAt: "2026-08-10T09:00:00.000Z", runId: older.runId }
    let poll: (() => void) | null = null
    const realSetInterval = globalThis.setInterval
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ...call: Parameters<typeof setInterval>
    ) => {
      const [handler, delay] = call
      if (delay === 4_000 && typeof handler === "function") {
        poll = handler
        return 100 as unknown as ReturnType<typeof setInterval>
      }
      return realSetInterval(...call)
    }) as typeof setInterval)
    let firstPageCalls = 0
    activityMock.mockResolvedValue({ ...activity, run: null })
    runsMock.mockImplementation(async (_projectId, options) => {
      if (options?.cursor) return runPage([older])
      firstPageCalls += 1
      return {
        available: true,
        runs: [{ ...active, done: firstPageCalls }],
        truncated: true,
        nextCursor: firstCursor,
      }
    })

    try {
      renderInspector({
        fallbackRun: active,
        fileNames: new Map([["file-1", "LUK.usfm"], ["file-old", "OLD.usfm"]]),
      })
      fireEvent.click(await screen.findByRole("button", { name: "Load older runs" }))
      expect(await screen.findByText("OLD.usfm")).toBeInTheDocument()
      expect(poll).toBeTypeOf("function")

      await act(async () => poll?.())

      expect(await screen.findByRole("button", { name: /LUK\.usfm.*2\/10 passages/i })).toBeInTheDocument()
      expect(screen.getByText("OLD.usfm")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Load older runs" })).not.toBeInTheDocument()
    } finally {
      intervalSpy.mockRestore()
    }
  })

  it("notifies the parent after a guarded run control succeeds", async () => {
    const parked = { ...run, status: "parked" }
    const stopped = { ...parked, status: "terminated" }
    const onRunChanged = vi.fn(async () => {})
    runsMock.mockResolvedValue(runPage([parked]))
    activityMock.mockResolvedValue({ ...activity, run: parked })
    commandMock.mockResolvedValue(stopped)
    renderInspector({ fallbackRun: parked, onRunChanged })

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }))
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalledWith("p1", RUN_ID, "terminate"))
    await vi.waitFor(() => expect(onRunChanged).toHaveBeenCalledTimes(1))
  })

  it("places per-collection truncation notices beside their evidence", async () => {
    activityMock.mockResolvedValue({
      ...activity,
      truncated: true,
      truncatedCollections: { events: true, sceneBriefs: true, drafts: true },
    })
    renderInspector({ initialSection: "review" })
    expect(await screen.findByText(/Only the most recent activity steps/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Technical & evidence.*1\+/i })).toBeInTheDocument()
    expect(screen.getByText(/Showing 1 of 1 ready-to-review draft records/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Context/ }))
    expect(screen.getByText(/Only the most recent scene briefs/)).toBeInTheDocument()
  })

  it("keeps a run-history warning visible when a later activity request succeeds", async () => {
    let resolveActivity!: (value: ContextualRunActivity) => void
    runsMock.mockRejectedValueOnce(new Error("offline"))
    activityMock.mockReturnValueOnce(new Promise((resolve) => { resolveActivity = resolve }))

    renderInspector({ fallbackRun: run })

    expect(await screen.findByText(/Could not refresh run history/)).toBeInTheDocument()
    await act(async () => resolveActivity(activity))
    expect(await screen.findByText("Staged 3 drafts for review.")).toBeInTheDocument()
    expect(screen.getByText(/Could not refresh run history/)).toBeInTheDocument()
  })

  it("Refresh retries both run history and selected activity", async () => {
    activityMock.mockRejectedValueOnce(new Error("offline"))
    renderInspector({ fallbackRun: run })

    expect(await screen.findByText(/Could not refresh detailed activity/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await vi.waitFor(() => expect(runsMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(activityMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("Staged 3 drafts for review.")).toBeInTheDocument()
    expect(screen.queryByText(/Could not refresh detailed activity/)).not.toBeInTheDocument()
  })

  it("links missing terminology and brief context to their real project surfaces", async () => {
    renderInspector({
      initialSection: "context",
      readiness: {
        ready: false,
        blockingGaps: 2,
        items: [
          { id: "terminology", label: "Key terms", level: "missing", detail: "Missing", href: "terminology" },
          { id: "brief", label: "Translation brief", level: "missing", detail: "Missing", href: "memory" },
        ],
      },
    })

    expect(await screen.findByRole("link", { name: "Set up Key terms" })).toHaveAttribute(
      "href",
      "/project/p1/terminology",
    )
    expect(screen.getByRole("link", { name: "Set up Translation brief" })).toHaveAttribute(
      "href",
      "/project/p1/memory",
    )
  })

  it("keeps a historic multilingual lane inspectable but cannot retry it", async () => {
    const legacyLane = {
      ...run,
      status: "failed",
      targetLang: "fr",
      lastError: "unsupported_target_language_lane",
    }
    runsMock.mockResolvedValue(runPage([legacyLane]))
    activityMock.mockResolvedValue({ ...activity, run: legacyLane })

    renderInspector({ initialSection: "attention" })

    expect(await screen.findByText("Target: fr")).toBeInTheDocument()
    expect(screen.getAllByText(/multilingual lane that Autopilot doesn’t support yet/)).toHaveLength(1)
    expect(screen.queryByText("unsupported_target_language_lane")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run Autopilot" })).not.toBeInTheDocument()
    await screen.findByText("Staged 3 drafts for review.")
    fireEvent.click(screen.getByRole("button", { name: /Ready to review/ }))
    expect(screen.queryByRole("link", { name: /Review in editor/ })).not.toBeInTheDocument()
    expect(await screen.findByText(/Evidence only.*unsupported fr lane/)).toBeInTheDocument()
    expect(retryMock).not.toHaveBeenCalled()
  })

  it("keeps stop and evidence for a paused multilingual run but suppresses resume", async () => {
    const pausedLegacyLane = {
      ...run,
      status: "paused",
      targetLang: "fr",
      lastError: null,
    }
    runsMock.mockResolvedValue(runPage([pausedLegacyLane]))
    activityMock.mockResolvedValue({ ...activity, run: pausedLegacyLane })

    renderInspector()

    expect(await screen.findByText(/multilingual lane that Autopilot doesn’t support yet/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
    expect(await screen.findByText("Staged 3 drafts for review.")).toBeInTheDocument()
  })

  it("does not select a historic multilingual proposal as the actionable review owner", async () => {
    const legacyLane = {
      ...run,
      runId: "newer-legacy-lane",
      fileId: "file-1",
      status: "done",
      targetLang: "fr",
      proposedDrafts: 2,
    }
    const defaultReview = {
      ...run,
      runId: "older-default-review",
      fileId: "file-2",
      status: "done",
      targetLang: "",
      proposedDrafts: 1,
    }
    runsMock.mockResolvedValue(runPage([legacyLane, defaultReview]))
    activityMock.mockImplementation(async (_projectId, runId) => ({
      ...activity,
      run: runId === defaultReview.runId ? defaultReview : legacyLane,
      drafts: runId === defaultReview.runId ? activity.drafts : [],
    }))

    renderInspector({
      initialSection: "review",
      overview: {
        available: true,
        proposedDrafts: 1,
        files: [],
        activeRuns: 0,
        doneSpans: 2,
        totalSpans: 2,
        failedSpans: 0,
        unitsSpent: 2,
        appliedDrafts: 0,
      },
      fileNames: new Map([["file-1", "Legacy.usfm"], ["file-2", "Default.usfm"]]),
    })

    await vi.waitFor(() => expect(activityMock).toHaveBeenCalledWith(
      "p1",
      defaultReview.runId,
      expect.objectContaining({ draftStatus: "proposed" }),
    ))
    expect(screen.getByText("2 evidence drafts")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Default\.usfm/ })).toHaveAttribute("aria-pressed", "true")
  })

  it.each([
    ["span_partial_cells_skipped", /completed suggestions were preserved for review/i],
    ["span_all_cells_skipped", /could not produce a reviewable draft/i],
  ])("maps %s to review-safe recovery copy", async (lastError, safeCopy) => {
    const failedRun = { ...run, status: "failed", lastError }
    runsMock.mockResolvedValue(runPage([failedRun]))
    activityMock.mockResolvedValue({ ...activity, run: failedRun })

    renderInspector({ initialSection: "attention" })

    expect(await screen.findByText(safeCopy)).toBeInTheDocument()
    expect(screen.queryByText(lastError)).not.toBeInTheDocument()
  })

  it.each([
    ["provider_http_error status=503", /model service couldn’t complete this run/i],
    ["provider_invalid_response status=200", /response Autopilot couldn’t use/i],
    ["provider_transport_error", /couldn’t reach the model service/i],
    ["provider_request_aborted", /request ended before it completed/i],
  ])("maps %s to safe primary copy", async (lastError, safeCopy) => {
    const providerFailure = {
      ...run,
      status: "failed",
      targetLang: "",
      lastError,
    }
    runsMock.mockResolvedValue(runPage([providerFailure]))
    activityMock.mockResolvedValue({ ...activity, run: providerFailure })

    renderInspector({ initialSection: "attention" })

    expect(await screen.findByText(safeCopy)).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(lastError.split(" ")[0], "i"))).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()
  })
})
