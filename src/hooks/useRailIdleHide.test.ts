// AQU-354 regression guard: the cell action rail must idle-collapse so it stops
// covering the "changed elsewhere while you were editing" conflict banner, while
// never collapsing an in-flight interaction and staying re-summonable.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useRailIdleHide, RAIL_IDLE_MS } from "./useRailIdleHide"

describe("useRailIdleHide", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("stays hidden when nothing reveals it", () => {
    const { result } = renderHook(() =>
      useRailIdleHide({ revealTriggered: false, pinned: false }),
    )
    expect(result.current.revealed).toBe(false)
  })

  it("reveals on an ephemeral trigger, then idle-collapses after the timeout", () => {
    const { result } = renderHook(() =>
      useRailIdleHide({ revealTriggered: true, pinned: false }),
    )
    expect(result.current.revealed).toBe(true)

    // Just before the timeout: still visible.
    act(() => void vi.advanceTimersByTime(RAIL_IDLE_MS - 1))
    expect(result.current.revealed).toBe(true)

    // At the timeout: collapsed, even though the trigger is still held (this is
    // exactly the reading-the-warning scenario — pointer/focus still on cell).
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current.revealed).toBe(false)
  })

  it("never idle-collapses while pinned (open menu / focused control)", () => {
    const { result } = renderHook(() =>
      useRailIdleHide({ revealTriggered: true, pinned: true }),
    )
    expect(result.current.revealed).toBe(true)
    act(() => void vi.advanceTimersByTime(RAIL_IDLE_MS * 5))
    expect(result.current.revealed).toBe(true)
  })

  it("re-summons on a fresh gesture after collapse, and re-arms the countdown", () => {
    const { result } = renderHook(() =>
      useRailIdleHide({ revealTriggered: true, pinned: false }),
    )
    act(() => void vi.advanceTimersByTime(RAIL_IDLE_MS))
    expect(result.current.revealed).toBe(false)

    // A fresh reveal gesture brings it back...
    act(() => result.current.registerActivity())
    expect(result.current.revealed).toBe(true)

    // ...and the idle countdown restarts from zero.
    act(() => void vi.advanceTimersByTime(RAIL_IDLE_MS - 1))
    expect(result.current.revealed).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current.revealed).toBe(false)
  })

  it("forces visible when pinned and does not immediately vanish when the pin releases", () => {
    const { result, rerender } = renderHook(
      ({ pinned }: { pinned: boolean }) =>
        useRailIdleHide({ revealTriggered: true, pinned }),
      { initialProps: { pinned: true } },
    )
    // Let a long time pass while pinned — the idle flag stays reset.
    act(() => void vi.advanceTimersByTime(RAIL_IDLE_MS * 3))
    expect(result.current.revealed).toBe(true)

    // Release the pin: still visible (not collapsed the instant the pin drops).
    rerender({ pinned: false })
    expect(result.current.revealed).toBe(true)

    // The countdown then re-arms from the release.
    act(() => void vi.advanceTimersByTime(RAIL_IDLE_MS))
    expect(result.current.revealed).toBe(false)
  })

  it("honors a custom idle period", () => {
    const { result } = renderHook(() =>
      useRailIdleHide({ revealTriggered: true, pinned: false, idleMs: 500 }),
    )
    act(() => void vi.advanceTimersByTime(499))
    expect(result.current.revealed).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current.revealed).toBe(false)
  })

  it("clears its timer on unmount without firing", () => {
    const { unmount } = renderHook(() =>
      useRailIdleHide({ revealTriggered: true, pinned: false }),
    )
    unmount()
    // Advancing timers after unmount must not throw (timer was cleared).
    expect(() => vi.advanceTimersByTime(RAIL_IDLE_MS * 2)).not.toThrow()
  })
})
