// AQU-646: how far past its window a take has run.
//
// Sam, 2026-08-26: the bar already turns red and already prints the take's
// length beside the line's length — "but what's missing is a sort of difference
// calculation so that people don't need to do math manually."
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { DurationBar } from "./DurationBar"

const overrun = () => screen.queryByTestId("rec-overrun-by")

describe("DurationBar — the overrun difference", () => {
  it("says how far over, once the take passes its window", () => {
    render(<DurationBar elapsedMs={3400} targetSec={2.8} />)
    expect(overrun()).toHaveTextContent("+0.6s")
  })

  // A take that is going fine has nothing to say here, and a third number on a
  // row this narrow would be read every time for no reason.
  it("stays out of the way while the take is inside its window", () => {
    render(<DurationBar elapsedMs={2400} targetSec={2.8} />)
    expect(overrun()).toBeNull()
  })

  it("is absent before a take has started", () => {
    // The bar renders in the idle state too, at zero elapsed — which must not
    // read as being 2.8 seconds under.
    render(<DurationBar elapsedMs={0} targetSec={2.8} />)
    expect(overrun()).toBeNull()
  })

  it("appears exactly when the bar turns red, never before", () => {
    const { unmount } = render(<DurationBar elapsedMs={2800} targetSec={2.8} />)
    // Dead on the target is not over it.
    expect(overrun()).toBeNull()
    unmount()
    render(<DurationBar elapsedMs={2801} targetSec={2.8} />)
    expect(overrun()).not.toBeNull()
    expect(overrun()!.className).toContain("text-red-500")
  })

  it("keeps the running time and the target beside it", () => {
    render(<DurationBar elapsedMs={3400} targetSec={2.8} />)
    // The difference is an addition, not a replacement: you still need to know
    // what the take is and what it is being measured against.
    expect(screen.getByText("0:03.4")).toBeInTheDocument()
    expect(screen.getByText(/0:02\.8/)).toBeInTheDocument()
  })

  // Sam, 2026-08-27: "it should be right justified. It should not be trying to
  // center itself." Three flat children under `justify-between` left the
  // difference floating in the middle of the row, drifting as the digits
  // changed; grouped with the target label it has a fixed edge to sit against.
  it("sits against the right edge, grouped with the target", () => {
    render(<DurationBar elapsedMs={3400} targetSec={2.8} />)
    const row = overrun()!.parentElement!.parentElement!
    // Two children, not three — which is what makes `justify-between` mean
    // "one at each end" instead of "and one somewhere in the middle".
    expect(row.children).toHaveLength(2)
    expect(row.className).toContain("justify-between")
    // The running time is the LEFT one; the difference rides with the target
    // on the right.
    expect(row.children[0].textContent).toBe("0:03.4")
    expect(row.children[1]).toContainElement(overrun())
    expect(row.children[1].textContent).toMatch(/0:02\.8/)
  })
})
