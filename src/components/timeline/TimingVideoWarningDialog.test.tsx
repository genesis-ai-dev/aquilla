// Flow A, file-scoped (pre-merge round): switching a file that has a linked
// video to Free timing hides the video — the dialog confirms before the mode
// changes. Testid and confirm-button name are inherited from the settings-era
// dialog so browser-pass guards keep matching.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimingVideoWarningDialog } from "./TimingVideoWarningDialog"

function renderDialog() {
  const handlers = { onConfirm: vi.fn(), onCancel: vi.fn() }
  render(<TimingVideoWarningDialog open {...handlers} />)
  return handlers
}

describe("TimingVideoWarningDialog", () => {
  it("keeps the settings-era testid and confirm name", () => {
    renderDialog()
    expect(screen.getByTestId("timing-video-warning")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Switch to Free timing$/ })).toBeInTheDocument()
  })

  it("confirm switches; cancel does not", () => {
    const h = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /^Switch to Free timing$/ }))
    expect(h.onConfirm).toHaveBeenCalledTimes(1)
    expect(h.onCancel).not.toHaveBeenCalled()
  })

  it("cancel leaves the mode alone", () => {
    const h = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }))
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    expect(h.onConfirm).not.toHaveBeenCalled()
  })
})
