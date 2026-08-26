// AQU-995: the wiring that makes the sliding refresh actually fire. The
// backgrounded tab is the case that matters most — a session goes stale
// precisely while nobody is looking at it, and an interval in a throttled
// background tab is not a reliable way to notice.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { act } from "react"

// vi.hoisted: vi.mock is lifted above the imports, so the spy has to be created
// there too or the factory closes over an uninitialised binding.
const { refreshActiveSession } = vi.hoisted(() => ({
  refreshActiveSession: vi.fn(async () => false),
}))
vi.mock("@/lib/frontier/session-refresh", () => ({ refreshActiveSession }))

import { useSessionRefresh } from "./useSessionRefresh"

/** happy-dom has no visibility control — drive the property the hook reads. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
}

beforeEach(() => {
  refreshActiveSession.mockClear()
  vi.useFakeTimers()
  setVisibility("visible")
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useSessionRefresh", () => {
  it("checks once on mount", () => {
    renderHook(() => useSessionRefresh())
    expect(refreshActiveSession).toHaveBeenCalledTimes(1)
  })

  it("checks again when a backgrounded tab becomes visible", () => {
    renderHook(() => useSessionRefresh())
    refreshActiveSession.mockClear()

    setVisibility("hidden")
    act(() => { document.dispatchEvent(new Event("visibilitychange")) })
    expect(refreshActiveSession).not.toHaveBeenCalled()

    setVisibility("visible")
    act(() => { document.dispatchEvent(new Event("visibilitychange")) })
    expect(refreshActiveSession).toHaveBeenCalledTimes(1)
  })

  it("keeps checking on an interval, for the tab left open for weeks", () => {
    renderHook(() => useSessionRefresh())
    refreshActiveSession.mockClear()

    act(() => { vi.advanceTimersByTime(3 * 60 * 60 * 1000) })
    expect(refreshActiveSession).toHaveBeenCalledTimes(3)
  })

  it("stops on unmount — no timers or listeners left behind", () => {
    const { unmount } = renderHook(() => useSessionRefresh())
    unmount()
    refreshActiveSession.mockClear()

    act(() => { vi.advanceTimersByTime(6 * 60 * 60 * 1000) })
    act(() => { document.dispatchEvent(new Event("visibilitychange")) })
    expect(refreshActiveSession).not.toHaveBeenCalled()
  })
})
