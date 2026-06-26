import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useTimelineClock } from "./useTimelineClock"

describe("useTimelineClock", () => {
  it("seeks and clamps to >= 0", () => {
    const { result } = renderHook(() => useTimelineClock())
    expect(result.current.currentSec).toBe(0)
    act(() => result.current.seekTo(5))
    expect(result.current.currentSec).toBe(5)
    act(() => result.current.seekTo(-3))
    expect(result.current.currentSec).toBe(0)
  })

  it("toggles play/pause", () => {
    const { result } = renderHook(() => useTimelineClock())
    expect(result.current.playing).toBe(false)
    act(() => result.current.play())
    expect(result.current.playing).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.playing).toBe(false)
  })
})
