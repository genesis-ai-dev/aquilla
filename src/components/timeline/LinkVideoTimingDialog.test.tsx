// Flow B (2026-08-05, simplified 2026-08-06; file-scoped in the pre-merge
// round; AQU-2204): linking a film to a file that follows its recordings says
// the file will then follow its source — link the film or cancel. No separate
// switch action: linking is what switches it.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { LinkVideoTimingDialog } from "./LinkVideoTimingDialog"

function renderDialog() {
  const handlers = { onLinkAnyway: vi.fn(), onCancel: vi.fn() }
  render(<LinkVideoTimingDialog open {...handlers} />)
  return handlers
}

describe("LinkVideoTimingDialog", () => {
  it("linking goes ahead on confirm", () => {
    const h = renderDialog()
    fireEvent.click(screen.getByTestId("link-video-anyway"))
    expect(h.onLinkAnyway).toHaveBeenCalledTimes(1)
    expect(h.onCancel).not.toHaveBeenCalled()
  })

  it("cancel links nothing", () => {
    const h = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }))
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    expect(h.onLinkAnyway).not.toHaveBeenCalled()
  })

  it("says linking makes the file follow its source, and that nothing is lost (AQU-2204)", () => {
    renderDialog()
    expect(screen.queryByTestId("link-video-switch")).toBeNull()
    expect(screen.getByText(/Linking a film makes this file follow its source/)).toBeInTheDocument()
    expect(screen.getByText(/No recordings\s+or times change/)).toBeInTheDocument()
    expect(screen.getByTestId("link-video-anyway")).toHaveTextContent("Link the film")
  })
})
