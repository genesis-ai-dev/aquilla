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

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"

function stubPlatform(platform: string, ua: string, touchPoints = 0) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua)
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(touchPoints)
}

describe("useMacTitlebarOverlay", () => {
  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).__TAURI__ = {}
    __resetMacTitlebarStoreForTests()
    win.state.fullscreen = false
    win.state.resized = []
    win.isFullscreen.mockClear()
    win.onResized.mockClear()
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI__
    vi.restoreAllMocks()
  })

  it("is on for the macOS desktop app only", () => {
    stubPlatform("MacIntel", MAC_UA)
    expect(isMacTitlebarOverlay()).toBe(true)
    // iOS WebKit says "like Mac OS X" — no traffic lights there.
    stubPlatform("iPhone", IPHONE_UA, 5)
    expect(isMacTitlebarOverlay()).toBe(false)
    // iPadOS desktop-class UA reports MacIntel, but has touch points.
    stubPlatform("MacIntel", MAC_UA, 5)
    expect(isMacTitlebarOverlay()).toBe(false)
    stubPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
    expect(isMacTitlebarOverlay()).toBe(false)
  })

  it("is off in the browser even on a Mac", () => {
    stubPlatform("MacIntel", MAC_UA)
    delete (window as unknown as Record<string, unknown>).__TAURI__
    const { result } = renderHook(() => useMacTitlebarOverlay())
    expect(result.current).toEqual({ overlay: false, inset: false })
    expect(win.isFullscreen).not.toHaveBeenCalled()
  })

  it("shares one fullscreen watch, so a fresh mount starts from the known state", async () => {
    stubPlatform("MacIntel", MAC_UA)
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
})
