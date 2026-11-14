import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import {
  __resetMacTitlebarStoreForTests,
  isMacTitlebarOverlay,
  useMacTitlebarOverlay,
} from "./useMacTitlebarOverlay"

const win = vi.hoisted(() => {
  const state = { fullscreen: false, resized: [] as Array<() => void> }
  return {
    state,
    isFullscreen: vi.fn(async () => state.fullscreen),
    onResized: vi.fn(async (cb: () => void) => {
      state.resized.push(cb)
      return () => {}
    }),
  }
})
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }))

const setOverlayFlag = (on: boolean) => {
  if (on) window.__AQUILLA_MAC_TITLEBAR_OVERLAY__ = true
  else delete window.__AQUILLA_MAC_TITLEBAR_OVERLAY__
}

describe("useMacTitlebarOverlay", () => {
  beforeEach(() => {
    setOverlayFlag(true)
    __resetMacTitlebarStoreForTests()
    win.state.fullscreen = false
    win.state.resized = []
    win.isFullscreen.mockClear()
    win.onResized.mockClear()
  })
  afterEach(() => {
    setOverlayFlag(false)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("is on only when the native shell says it built an overlay title bar", () => {
    expect(isMacTitlebarOverlay()).toBe(true)
    // Browser, Windows/Linux shell, or an older macOS shell: no flag.
    setOverlayFlag(false)
    expect(isMacTitlebarOverlay()).toBe(false)
  })

  it("is off without the flag, and never watches fullscreen", () => {
    setOverlayFlag(false)
    const { result } = renderHook(() => useMacTitlebarOverlay())
    expect(result.current).toEqual({ overlay: false, inset: false })
    expect(win.isFullscreen).not.toHaveBeenCalled()
  })

  it("shares one fullscreen watch, so a fresh mount starts from the known state", async () => {
    win.state.fullscreen = true
    const first = renderHook(() => useMacTitlebarOverlay())
    await waitFor(() => expect(first.result.current.inset).toBe(false))
    first.unmount()

    // A route change mounts a new AppShell: no inset flash while fullscreen.
    const seen: boolean[] = []
    function Probe() {
      seen.push(useMacTitlebarOverlay().inset)
      return null
    }
    render(<Probe />)
    expect(seen[0]).toBe(false)
    expect(win.onResized).toHaveBeenCalledTimes(1)

    // Leaving fullscreen resizes the window; every mount follows.
    win.state.fullscreen = false
    await act(async () => {
      for (const cb of win.state.resized) cb()
    })
    await waitFor(() => expect(seen.at(-1)).toBe(true))
  })

  it("checks once a burst of resizes settles, then once more after the animation", async () => {
    vi.useFakeTimers()
    renderHook(() => useMacTitlebarOverlay())
    await vi.waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1))
    expect(win.isFullscreen).toHaveBeenCalledTimes(1)

    // A live drag-resize: dozens of events, no IPC per event.
    for (let i = 0; i < 40; i++) {
      for (const cb of win.state.resized) cb()
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(win.isFullscreen).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(win.isFullscreen).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(win.isFullscreen).toHaveBeenCalledTimes(3)
  })

  it("catches a fullscreen exit that macOS reports late", async () => {
    vi.useFakeTimers()
    win.state.fullscreen = true
    const { result } = renderHook(() => useMacTitlebarOverlay())
    await vi.waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1))
    expect(result.current.inset).toBe(false)

    // The last resize of the exit animation lands while the window still
    // says fullscreen; the flag clears only afterwards.
    await act(async () => {
      for (const cb of win.state.resized) cb()
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.inset).toBe(false)
    win.state.fullscreen = false
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(result.current.inset).toBe(true)
  })

  it("ignores a stale reply that arrives after a newer one", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useMacTitlebarOverlay())
    await vi.waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1))

    let resolveSlow: (v: boolean) => void = () => {}
    win.isFullscreen
      .mockImplementationOnce(() => new Promise<boolean>((r) => { resolveSlow = r }))
      .mockImplementationOnce(async () => true)
    await act(async () => {
      for (const cb of win.state.resized) cb()
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.inset).toBe(false)
    // The first (older) check finally answers "not fullscreen": too late.
    await act(async () => { resolveSlow(false) })
    expect(result.current.inset).toBe(false)
  })
})
