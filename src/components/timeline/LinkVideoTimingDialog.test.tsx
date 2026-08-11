// Flow B (2026-08-05, simplified 2026-08-06; file-scoped in the pre-merge
// round): linking a video under Free timing warns it will stay hidden — link
// anyway or cancel. No combined switch-and-link action: keeps the privilege
// story simple for this release.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { LinkVideoTimingDialog } from "./LinkVideoTimingDialog"

function renderDialog() {
  const handlers = { onLinkAnyway: vi.fn(), onCancel: vi.fn() }
  render(<LinkVideoTimingDialog open {...handlers} />)
  return handlers
}

describe("LinkVideoTimingDialog", () => {
  it("link-anyway links (video stays hidden)", () => {
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

  it("offers NO mode-switch action — that authority is the toolbar control's", () => {
    renderDialog()
    expect(screen.queryByTestId("link-video-switch")).toBeNull()
    expect(screen.getByText(/a maintainer can change\s+that any time with the timing control in the Media timeline/)).toBeInTheDocument()
  })
})
