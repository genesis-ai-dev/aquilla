// AQU-361: CompletionBulkProgressBanner must surface an honest failure
// summary when a batch run ends with skipped cells, instead of quietly
// disappearing (the store keeps `finished: true` progress around for this).

import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { CompletionBulkProgressBanner } from "./CompletionBulkProgressBanner"
import {
  resetBatchCompletionState,
  clearBatchCompletionProgress,
  dismissBatchCompletionSummary,
  incrementBatchCompletionDone,
  incrementBatchCompletionFailed,
  reportBatchCompletionUnavailable,
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
    expect(screen.getByText(/60 completed/)).toBeInTheDocument()
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
