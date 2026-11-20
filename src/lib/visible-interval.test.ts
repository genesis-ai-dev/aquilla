import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startVisibleInterval } from "./visible-interval"

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
  document.dispatchEvent(new Event("visibilitychange"))
}

describe("startVisibleInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility("visible")
  })
  afterEach(() => {
    setVisibility("visible")
    vi.useRealTimers()
  })

  it("ticks on the interval while the tab is visible", () => {
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1_000)
    vi.advanceTimersByTime(3_000)
    expect(tick).toHaveBeenCalledTimes(3)
    stop()
  })

  it("sends nothing while the tab is hidden, then once on return", () => {
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1_000)
    setVisibility("hidden")
    vi.advanceTimersByTime(10_000)
    expect(tick).not.toHaveBeenCalled()

    setVisibility("visible")
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(tick).toHaveBeenCalledTimes(2)
    stop()
  })

  it("does not tick on return when no tick was skipped", () => {
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1_000)
    setVisibility("hidden")
    vi.advanceTimersByTime(500)
    setVisibility("visible")
    expect(tick).not.toHaveBeenCalled()
    stop()
  })

  it("stops both the timer and the visibility listener", () => {
    const tick = vi.fn()
    const stop = startVisibleInterval(tick, 1_000)
    setVisibility("hidden")
    vi.advanceTimersByTime(2_000)
    stop()
    setVisibility("visible")
    vi.advanceTimersByTime(5_000)
    expect(tick).not.toHaveBeenCalled()
  })
})
