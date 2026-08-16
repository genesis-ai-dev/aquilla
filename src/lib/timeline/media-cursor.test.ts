import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  getMediaCursorCell,
  resetMediaCursorForTests,
  setMediaCursorCell,
  setMediaSyncActive,
  useIsMediaCursorCell,
  useMediaSyncActive,
} from "./media-cursor"

describe("media-cursor store", () => {
  beforeEach(() => resetMediaCursorForTests())

  it("rows only read the cursor while the timeline is mounted", () => {
    const { result } = renderHook(() => useIsMediaCursorCell("c1"))
    act(() => setMediaCursorCell("c1"))
    // No timeline → no highlight, even with a cursor value written.
    expect(result.current).toBe(false)
    act(() => setMediaSyncActive(true))
    expect(result.current).toBe(true)
  })

  it("a cursor move re-points exactly one cell at a time", () => {
    const a = renderHook(() => useIsMediaCursorCell("a"))
    const b = renderHook(() => useIsMediaCursorCell("b"))
    act(() => {
      setMediaSyncActive(true)
      setMediaCursorCell("a")
    })
    expect(a.result.current).toBe(true)
    expect(b.result.current).toBe(false)
    act(() => setMediaCursorCell("b"))
    expect(a.result.current).toBe(false)
    expect(b.result.current).toBe(true)
  })

  it("timeline unmount clears the cursor so the Text lens never inherits it", () => {
    act(() => {
      setMediaSyncActive(true)
      setMediaCursorCell("c9")
    })
    expect(getMediaCursorCell()).toBe("c9")
    act(() => setMediaSyncActive(false))
    expect(getMediaCursorCell()).toBeNull()
    const { result } = renderHook(() => useMediaSyncActive())
    expect(result.current).toBe(false)
  })
})
