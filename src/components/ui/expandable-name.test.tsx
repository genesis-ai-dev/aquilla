import { describe, it, expect, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { ExpandableName } from "./expandable-name"

// AQU-491: full episode/file names used to be discoverable only via hover
// (tooltip) — "At first, I was trying to find a way to expand the episode
// name... After a while, I realized that hovering over it displays the full
// name." (Anna, PM). happy-dom has no real layout engine, so scrollWidth/
// clientWidth are both 0 by default; these tests stub them on the element
// prototype to simulate actual overflow/no-overflow, the same signal the
// component reads in a real browser.
function mockOverflow(overflowing: boolean) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return overflowing ? 400 : 80
    },
  })
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 128
    },
  })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth")
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth")
})

describe("ExpandableName", () => {
  it("shows a click-to-expand cue and reveals the full name without hover when the text is truncated", () => {
    mockOverflow(true)
    const longName = "Genesis_Episode_47_The_Long_Journey_Home_Final_Mix_v3.wav"
    render(<ExpandableName name={longName} />)

    // Visible, non-hover cue: an enabled button naming the full text via
    // aria-label, distinct from the plain (non-interactive) case below.
    const trigger = screen.getByRole("button", { name: `Show full name: ${longName}` })
    expect(trigger).toBeEnabled()

    // Full name is not yet shown a second time (popover closed).
    expect(screen.getAllByText(longName)).toHaveLength(1)

    // Click (not hover) reveals the full name.
    fireEvent.click(trigger)
    expect(screen.getAllByText(longName).length).toBeGreaterThanOrEqual(2)
  })

  it("renders a plain, non-interactive name with no expand cue when it isn't truncated", () => {
    mockOverflow(false)
    render(<ExpandableName name="Short.wav" />)

    // No button affordance — nothing to expand, so no false cue.
    expect(screen.queryByRole("button", { name: /show full name/i })).not.toBeInTheDocument()
    expect(screen.getByText("Short.wav")).toBeInTheDocument()
  })
})
