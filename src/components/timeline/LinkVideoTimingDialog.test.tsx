// Flow B (2026-08-05): the three-way choice when linking a video under Free
// timing — switch back and link, link anyway (video stays hidden), or cancel.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { LinkVideoTimingDialog } from "./LinkVideoTimingDialog"

function renderDialog(over: Partial<Parameters<typeof LinkVideoTimingDialog>[0]> = {}) {
  const handlers = {
    onSwitchToOriginal: vi.fn(),
    onLinkAnyway: vi.fn(),
    onCancel: vi.fn(),
  }
  render(
    <LinkVideoTimingDialog open canSwitch {...handlers} {...over} />,
  )
  return handlers
}

describe("LinkVideoTimingDialog", () => {
  it("switch action links AND switches", () => {
    const h = renderDialog()
    fireEvent.click(screen.getByTestId("link-video-switch"))
    expect(h.onSwitchToOriginal).toHaveBeenCalledTimes(1)
    expect(h.onLinkAnyway).not.toHaveBeenCalled()
  })

  it("link-anyway links without switching (video stays hidden)", () => {
    const h = renderDialog()
    fireEvent.click(screen.getByTestId("link-video-anyway"))
    expect(h.onLinkAnyway).toHaveBeenCalledTimes(1)
    expect(h.onSwitchToOriginal).not.toHaveBeenCalled()
  })

  it("cancel does neither", () => {
    const h = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }))
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    expect(h.onLinkAnyway).not.toHaveBeenCalled()
    expect(h.onSwitchToOriginal).not.toHaveBeenCalled()
  })

  it("below the maintainer floor the switch action is replaced by a hint", () => {
    renderDialog({ canSwitch: false })
    expect(screen.queryByTestId("link-video-switch")).toBeNull()
    expect(screen.getByText(/Only a maintainer can change the timing mode/)).toBeInTheDocument()
    expect(screen.getByTestId("link-video-anyway")).toBeInTheDocument()
  })
})
