// AQU-361: CompletionBulkProgressBanner must surface an honest failure
// summary when a batch run ends with skipped cells, instead of quietly
// disappearing (the store keeps `finished: true` progress around for this).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { CompletionBulkProgressBanner, CompletionBatchStatusHost } from "./CompletionBulkProgressBanner"
import {
  resetBatchCompletionState,
  clearBatchCompletionProgress,
  dismissBatchCompletionSummary,
  incrementBatchCompletionDone,
  incrementBatchCompletionFailed,
  reportBatchCompletionUnavailable,
  finishBatchCompletion,
  recordBatchCompletionDone,
  recordBatchCompletionFailed,
  registerBatchCompletionResumer,
  cancelBatchCompletion,
  getCompletionBatchProgress,
  STALL_CEILING_MS,
} from "@/lib/completion/batch-completion"

describe("CompletionBulkProgressBanner", () => {
  beforeEach(() => {
    dismissBatchCompletionSummary()
  })

  it("renders nothing when idle", () => {
    const { container } = render(<CompletionBulkProgressBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a progress bar while a batch is running", () => {
    resetBatchCompletionState(90)
    render(<CompletionBulkProgressBanner />)
    expect(screen.getByText("Translating")).toBeInTheDocument()
    expect(screen.getByText("0/90")).toBeInTheDocument()
  })

  it("says so when a batch was refused because the AI service is unreachable (AQU-1377)", () => {
    // completeBatch used to `return` here, so the click produced no banner at
    // all and the feature looked broken until a reload.
    reportBatchCompletionUnavailable()
    render(<CompletionBulkProgressBanner />)

    expect(screen.getByText(/AI service unavailable/)).toBeInTheDocument()
    expect(screen.queryByText("Translating")).not.toBeInTheDocument()

    // Dismissible by the same close button the failure summary uses.
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(screen.queryByText(/AI service unavailable/)).not.toBeInTheDocument()
  })

  it("does not talk over a batch that is still generating (AQU-1377)", () => {
    resetBatchCompletionState(90)
    reportBatchCompletionUnavailable()
    render(<CompletionBulkProgressBanner />)

    // The live progress bar is the more useful thing on screen.
    expect(screen.getByText("Translating")).toBeInTheDocument()
    expect(screen.queryByText(/AI service unavailable/)).not.toBeInTheDocument()
  })

  it("shows an honest failure summary once the run finishes with skipped cells (AQU-361)", () => {
    const runId = resetBatchCompletionState(90)
    for (let i = 0; i < 60; i++) incrementBatchCompletionDone(runId)
    incrementBatchCompletionFailed(runId, 30)
    clearBatchCompletionProgress(runId)

    render(<CompletionBulkProgressBanner />)

    expect(screen.getByText(/30 of 90 cells failed/)).toBeInTheDocument()
    expect(screen.getByText(/60 drafted/)).toBeInTheDocument()
    // Must NOT silently render nothing / a stale progress bar.
    expect(screen.queryByText("Translating")).not.toBeInTheDocument()
  })

  it("dismiss button clears the failure summary", () => {
    const runId = resetBatchCompletionState(10)
    incrementBatchCompletionFailed(runId, 5)
    clearBatchCompletionProgress(runId)

    render(<CompletionBulkProgressBanner />)
    fireEvent.click(screen.getByLabelText("Dismiss"))

    expect(screen.queryByText(/cells failed/)).not.toBeInTheDocument()
  })

  it("clears normally (no summary) when a run finishes with zero failures", () => {
    const runId = resetBatchCompletionState(10)
    for (let i = 0; i < 10; i++) incrementBatchCompletionDone(runId)
    clearBatchCompletionProgress(runId)

    const { container } = render(<CompletionBulkProgressBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})

// AQU-2654: the banner is how a run tells the truth about itself — which file,
// how far, how long, and a terminal state for every way it can end.
describe("CompletionBulkProgressBanner — an honest run (AQU-2654)", () => {
  const IDS = Array.from({ length: 12 }, (_, i) => `cell-${i + 1}`)
  const SCOPE = { projectId: "p1", fileId: "f1", fileName: "Guide.docx" }
  const start = () => resetBatchCompletionState(IDS.length, { cellIds: IDS, scope: SCOPE })

  beforeEach(() => {
    vi.useRealTimers()
    dismissBatchCompletionSummary()
  })
  afterEach(() => {
    vi.useRealTimers()
    dismissBatchCompletionSummary()
  })

  it("names the file and shows the elapsed time while running", () => {
    vi.useFakeTimers()
    const runId = start()
    render(<CompletionBulkProgressBanner />)
    act(() => {
      recordBatchCompletionDone(runId, IDS.slice(0, 5))
      vi.advanceTimersByTime(65_000)
    })

    expect(screen.getByText("Translating Guide.docx")).toBeInTheDocument()
    expect(screen.getByText("5/12")).toBeInTheDocument()
    expect(screen.getByLabelText("1:05 elapsed")).toBeInTheDocument()
  })

  it("shows completion — a finished run does not just disappear", () => {
    vi.useFakeTimers()
    const runId = start()
    render(<CompletionBulkProgressBanner />)
    act(() => {
      vi.advanceTimersByTime(125_000)
      recordBatchCompletionDone(runId, IDS)
      finishBatchCompletion(runId)
    })

    expect(screen.getByText("12 cells drafted in 2:05.")).toBeInTheDocument()
    expect(screen.getByTestId("completion-batch-status")).toHaveAttribute("data-outcome", "done")
    // A run long enough to walk away from keeps its completion until dismissed.
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    expect(screen.getByText("12 cells drafted in 2:05.")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Dismiss"))
    expect(screen.queryByTestId("completion-batch-status")).not.toBeInTheDocument()
  })

  it("a run the user watched start to finish clears its own completion line", () => {
    vi.useFakeTimers()
    const runId = start()
    render(<CompletionBulkProgressBanner />)
    act(() => {
      vi.advanceTimersByTime(8_000)
      recordBatchCompletionDone(runId, IDS)
      finishBatchCompletion(runId)
    })
    expect(screen.getByText("12 cells drafted in 0:08.")).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(7_000) })
    expect(screen.queryByTestId("completion-batch-status")).not.toBeInTheDocument()
  })

  it("a failed run names the cells, gives the reason and retries the remainder", () => {
    const resumer = vi.fn(() => true)
    const unregister = registerBatchCompletionResumer("p1", resumer)
    const runId = start()
    recordBatchCompletionDone(runId, IDS.slice(0, 2))
    recordBatchCompletionFailed(runId, IDS.slice(2).map((cellId, i) => ({
      cellId,
      label: `MAT 5:${i + 3}`,
      reason: "Request timed out",
    })))
    finishBatchCompletion(runId)
    render(<CompletionBulkProgressBanner />)

    expect(screen.getByRole("alert")).toHaveAttribute("data-outcome", "failed")
    expect(screen.getByText(/10 of 12 cells failed/)).toBeInTheDocument()
    expect(
      screen.getByText("Not drafted: MAT 5:3, MAT 5:4, MAT 5:5, MAT 5:6, MAT 5:7 and 5 more"),
    ).toBeInTheDocument()
    expect(screen.getByText("Reason: Request timed out")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Retry 10 cells" }))
    expect(resumer).toHaveBeenCalledWith(IDS.slice(2))
    unregister()
  })

  it("says why when the run itself broke off", () => {
    const runId = start()
    recordBatchCompletionDone(runId, IDS.slice(0, 4))
    finishBatchCompletion(runId, { error: new Error("Failed to fetch") })
    render(<CompletionBulkProgressBanner />)

    expect(screen.getByText(/8 of 12 cells failed — 4 drafted/)).toBeInTheDocument()
    expect(screen.getByText("Drafting stopped unexpectedly: Failed to fetch")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry 8 cells" })).toBeInTheDocument()
  })

  it("a stopped run says so and offers the rest", () => {
    const runId = start()
    recordBatchCompletionDone(runId, IDS.slice(0, 3))
    cancelBatchCompletion()
    finishBatchCompletion(runId)
    render(<CompletionBulkProgressBanner />)

    expect(screen.getByText("Stopped — 3 of 12 cells drafted.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Draft the remaining 9 cells" })).toBeInTheDocument()
  })

  it("a run with no progress for the stall ceiling offers Retry and Stop instead of waiting forever", () => {
    vi.useFakeTimers()
    const resumer = vi.fn(() => true)
    const unregister = registerBatchCompletionResumer("p1", resumer)
    const runId = start()
    render(<CompletionBulkProgressBanner />)
    act(() => {
      recordBatchCompletionDone(runId, IDS.slice(0, 2))
      vi.advanceTimersByTime(STALL_CEILING_MS + 30_000)
    })

    expect(screen.getByTestId("completion-batch-status")).toHaveAttribute("data-outcome", "stalled")
    expect(screen.getByText(/No progress for 5 minutes/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry 10 cells" }))
    expect(resumer).toHaveBeenCalledWith(IDS.slice(2))

    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(getCompletionBatchProgress()).toMatchObject({ finished: true, outcome: "stopped" })
    expect(screen.getByText("Stopped — 2 of 12 cells drafted.")).toBeInTheDocument()
    unregister()
  })

  it("when the file is not open, Retry says so and links to it", () => {
    const runId = start()
    finishBatchCompletion(runId, { error: new Error("boom") })
    render(
      <MemoryRouter>
        <CompletionBulkProgressBanner />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Retry 12 cells" }))
    expect(screen.getByText(/Open Guide.docx in the editor, then try again/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open file" })).toHaveAttribute(
      "href",
      "/project/p1/editor/file/f1",
    )
  })
})

describe("CompletionBatchStatusHost — visible away from the editor (AQU-2654)", () => {
  beforeEach(() => {
    dismissBatchCompletionSummary()
  })
  afterEach(() => {
    dismissBatchCompletionSummary()
  })

  it("shows the run app-wide when the editor's banner is not mounted", () => {
    resetBatchCompletionState(40, { scope: { projectId: "p1", fileId: "f1", fileName: "Guide.docx" } })
    render(<CompletionBatchStatusHost />)
    expect(screen.getByText("Translating Guide.docx")).toBeInTheDocument()
    expect(screen.getByText("0/40")).toBeInTheDocument()
  })

  it("stands down while the editor shows the banner inline, and takes over when it unmounts", () => {
    resetBatchCompletionState(40, { scope: { fileName: "Guide.docx" } })
    const editor = render(<CompletionBulkProgressBanner />)
    render(<CompletionBatchStatusHost />)
    expect(screen.getAllByText("Translating Guide.docx")).toHaveLength(1)

    // The user leaves the editor mid-run: progress must follow them.
    editor.unmount()
    expect(screen.getAllByText("Translating Guide.docx")).toHaveLength(1)
    expect(screen.getByText("0/40")).toBeInTheDocument()
  })
})
