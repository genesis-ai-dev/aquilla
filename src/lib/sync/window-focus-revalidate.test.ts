import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetWindowFocusRevalidateForTests,
  subscribeWindowRegainedFocus,
} from "./window-focus-revalidate"

// One alt-tab used to fan out into 6–7 concurrent revalidation requests (one
// per hook). These tests pin the coordinator's contract: one wave per return,
// rate-limited across subscribers, and no wave at all for a quick tab peek.

let clock = 0
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  clock = 100_000
  resetWindowFocusRevalidateForTests({ now: () => clock })
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
})

afterEach(() => {
  resetWindowFocusRevalidateForTests()
})

describe("subscribeWindowRegainedFocus", () => {
  it("fans one focus out to every subscriber exactly once", () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeWindowRegainedFocus(a)
    subscribeWindowRegainedFocus(b)

    window.dispatchEvent(new Event("focus"))

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("collapses the focus + visibilitychange pair of a single alt-tab into one wave", () => {
    const fn = vi.fn()
    subscribeWindowRegainedFocus(fn)

    setVisibility("hidden")
    clock += 10_000
    setVisibility("visible")
    window.dispatchEvent(new Event("focus"))

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("rate-limits repeated returns to one wave per 5s", () => {
    const fn = vi.fn()
    subscribeWindowRegainedFocus(fn)

    window.dispatchEvent(new Event("focus"))
    clock += 4_999
    window.dispatchEvent(new Event("focus"))
    expect(fn).toHaveBeenCalledTimes(1)

    clock += 1
    window.dispatchEvent(new Event("focus"))
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("skips a tab that was hidden for under 2s — nothing was missed", () => {
    const fn = vi.fn()
    subscribeWindowRegainedFocus(fn)

    setVisibility("hidden")
    clock += 1_500
    setVisibility("visible")
    window.dispatchEvent(new Event("focus"))

    expect(fn).not.toHaveBeenCalled()
  })

  it("ignores focus while the document is hidden and hidden-transition events", () => {
    const fn = vi.fn()
    subscribeWindowRegainedFocus(fn)

    setVisibility("hidden")
    window.dispatchEvent(new Event("focus"))

    expect(fn).not.toHaveBeenCalled()
  })

  it("stops delivering after unsubscribe and drops the DOM listener at zero subscribers", () => {
    const fn = vi.fn()
    const unsub = subscribeWindowRegainedFocus(fn)
    unsub()

    window.dispatchEvent(new Event("focus"))

    expect(fn).not.toHaveBeenCalled()
  })

  it("a throwing subscriber does not starve the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const bad = vi.fn(() => { throw new Error("boom") })
    const good = vi.fn()
    subscribeWindowRegainedFocus(bad)
    subscribeWindowRegainedFocus(good)

    window.dispatchEvent(new Event("focus"))

    expect(good).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
