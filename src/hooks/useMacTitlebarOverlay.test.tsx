import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import {
  __resetMacTitlebarStoreForTests,
  isMacTitlebarOverlay,
  useMacTitlebarOverlay,
  useTopBannerDrag,
} from "./useMacTitlebarOverlay"

const win = vi.hoisted(() => {
  const state = { fullscreen: false, resized: [] as Array<() => void> }
  return {
    state,
    isFullscreen: vi.fn(async () => state.fullscreen),
    startDragging: vi.fn(async () => {}),
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
    sessionStorage.clear()
    __resetMacTitlebarStoreForTests()
    win.state.fullscreen = false
    win.state.resized = []
    win.isFullscreen.mockClear()
    win.onResized.mockClear()
    win.startDragging.mockClear()
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

  it("keeps watching when the first fullscreen check fails", async () => {
    vi.useFakeTimers()
    win.isFullscreen.mockImplementationOnce(async () => { throw new Error("ipc not ready") })
    const { result } = renderHook(() => useMacTitlebarOverlay())
    await vi.waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1))
    expect(result.current.inset).toBe(true)

    // Entering fullscreen later is still seen.
    win.state.fullscreen = true
    await act(async () => {
      for (const cb of win.state.resized) cb()
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.inset).toBe(false)
  })

  it("retries on its own when the resize listener can't be registered", async () => {
    vi.useFakeTimers()
    win.onResized.mockImplementationOnce(async () => { throw new Error("ipc not ready") })
    const { result } = renderHook(() => useMacTitlebarOverlay())
    await vi.waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1))

    // No remount: the store retries with backoff and registers the listener.
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(win.onResized).toHaveBeenCalledTimes(2)
    expect(win.state.resized).toHaveLength(1)

    // The component that was already mounted now follows fullscreen.
    win.state.fullscreen = true
    await act(async () => {
      for (const cb of win.state.resized) cb()
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.inset).toBe(false)
  })

  it("starts from the last value this tab saw, so a reload in fullscreen paints no inset", async () => {
    win.state.fullscreen = true
    const before = renderHook(() => useMacTitlebarOverlay())
    await waitFor(() => expect(before.result.current.inset).toBe(false))
    before.unmount()

    // Reload: module state is gone, the native answer hasn't arrived yet.
    __resetMacTitlebarStoreForTests()
    win.isFullscreen.mockImplementationOnce(() => new Promise<boolean>(() => {}))
    const after = renderHook(() => useMacTitlebarOverlay())
    expect(after.result.current.inset).toBe(false)
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

  it("a top-pinned banner drags the window from its empty space, not from its controls", async () => {
    function Banner() {
      const drag = useTopBannerDrag()
      return (
        <div data-testid="banner" {...drag}>
          <span>Message</span>
          <button type="button">Dismiss</button>
        </div>
      )
    }
    render(<Banner />)
    fireEvent.mouseDown(screen.getByRole("button"), { button: 0, detail: 1 })
    fireEvent.mouseDown(screen.getByText("Message"), { button: 0, detail: 1 })
    await waitFor(() => expect(win.startDragging).toHaveBeenCalledTimes(1))
  })

  it("a banner is no drag handle outside the overlay shell", () => {
    setOverlayFlag(false)
    const { result } = renderHook(() => useTopBannerDrag())
    expect(result.current).toEqual({})
  })
})
