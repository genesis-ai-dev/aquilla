// AQU-1377: the AI availability probe must recover on reconnect.
//
// The bug this pins: turning Wi-Fi off/on at the OS level takes the tab out of
// and back into focus, the session store notifies on focus, and that forces a
// health probe WHILE the network is down. The failure was cached as
// `available: false` with a fresh timestamp, nothing subscribed to the browser's
// `online` event, and so every AI control stayed off for the rest of the TTL —
// `completeBatch` returned silently and clicking Translate on a selection did
// nothing at all until the page was reloaded.
//
// Two independent guards are tested, because either alone can be defeated:
//   1. a probe that runs while offline does not record a snapshot at all, so a
//      negative earned offline cannot age into a cached truth; and
//   2. the hook forces a fresh probe on the browser `online` event.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// The hook's session listener, so a test can raise the store's notification.
const sessionListeners = vi.hoisted(() => new Set<() => void>())
vi.mock("@/lib/frontier/session-store", () => ({
  subscribeSession: (listener: () => void) => {
    sessionListeners.add(listener)
    return () => { sessionListeners.delete(listener) }
  },
}))
vi.mock("@/lib/frontier/auth", () => ({ AUTH_BASE: "https://auth.test" }))

// The probe caches in module scope, so each test needs a fresh module.
async function loadModule() {
  vi.resetModules()
  return await import("./frontier-health")
}

function setOnLine(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    value,
    configurable: true,
    writable: true,
  })
}

describe("frontier-health — reconnect recovery (AQU-1377)", () => {
  beforeEach(() => {
    setOnLine(true)
    sessionListeners.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    setOnLine(true)
  })

  it("does not cache a negative earned while the browser is offline", async () => {
    const { checkFrontierHealth } = await loadModule()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal("fetch", fetchMock)

    // A forced probe fires while offline — exactly what the focus handler does
    // when the OS Wi-Fi toggle moves focus. It must report unavailable...
    setOnLine(false)
    expect(await checkFrontierHealth(true)).toBe(false)
    // ...without reaching the network, and without leaving a snapshot behind.
    expect(fetchMock).not.toHaveBeenCalled()

    // Back online: the very next probe must really hit the network rather than
    // being served a fresh-looking negative for the remainder of the 60s TTL.
    setOnLine(true)
    expect(await checkFrontierHealth()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("still caches a genuine negative taken while online", async () => {
    const { checkFrontierHealth } = await loadModule()
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response)
    vi.stubGlobal("fetch", fetchMock)

    expect(await checkFrontierHealth()).toBe(false)
    // Second call inside the TTL is served from cache — the service really is
    // down, so this negative is allowed to stick (no false positive, AC 4).
    expect(await checkFrontierHealth()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("re-probes on the browser `online` event and flips the controls back on", async () => {
    const { useFrontierHealth } = await loadModule()
    // Offline at mount: the initial probe reports unavailable.
    setOnLine(false)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useFrontierHealth())
    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(result.current.available).toBe(false)

    // Reconnect. No reload, no focus change, no session write — the `online`
    // event alone must force a fresh probe and turn the AI controls back on.
    setOnLine(true)
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })

    await waitFor(() => expect(result.current.available).toBe(true))
    expect(fetchMock).toHaveBeenCalled()
  })

  // AQU-2654: the session store notifies on every return to the tab.
  it("re-probes quietly behind an available answer, and still applies a change", async () => {
    const { useFrontierHealth } = await loadModule()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal("fetch", fetchMock)
    const seen: boolean[] = []
    const { result } = renderHook(() => {
      const state = useFrontierHealth()
      seen.push(state.checking)
      return state
    })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checking).toBe(false))
    seen.length = 0

    await act(async () => {
      for (const listener of sessionListeners) listener()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    // Nothing to say: no "checking" render, no render at all.
    expect(seen).toEqual([])

    // The service went away while the tab was hidden: the quiet probe says so.
    fetchMock.mockResolvedValue({ ok: false } as Response)
    await act(async () => {
      for (const listener of sessionListeners) listener()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.available).toBe(false))
    // And from "unavailable" the re-probe shows itself again, as before.
    fetchMock.mockResolvedValue({ ok: true } as Response)
    seen.length = 0
    await act(async () => {
      for (const listener of sessionListeners) listener()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(seen).toContain(true)
  })

  it("removes the `online` listener on unmount", async () => {
    const { useFrontierHealth } = await loadModule()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response))
    const remove = vi.spyOn(window, "removeEventListener")

    const { unmount } = renderHook(() => useFrontierHealth())
    unmount()

    expect(remove).toHaveBeenCalledWith("online", expect.any(Function))
  })
})
