/**
 * AQU-1155: the sync pill must report distance from truth. Before this the
 * status was "live" whenever navigator.onLine was true — even while the
 * outbox was retrying failed writes or the project socket was closed.
 *
 * `deriveSyncStatus` is exercised on every branch; the hook tests lock the
 * wiring (online events, socket sampling, outbox inputs) to the helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { deriveSyncStatus, useFileSync, type SyncSignals } from "./useFileSync"

const healthy: SyncSignals = {
  enabled: true,
  online: true,
  socketOpen: true,
  pendingCount: 0,
  failureStreak: 0,
}

describe("deriveSyncStatus", () => {
  it("is live only when online, socket open, and the outbox is empty", () => {
    expect(deriveSyncStatus(healthy)).toBe("live")
  })

  it("is disabled when there is nothing to sync, regardless of other signals", () => {
    expect(deriveSyncStatus({ ...healthy, enabled: false })).toBe("disabled")
    expect(
      deriveSyncStatus({ ...healthy, enabled: false, online: false, pendingCount: 5, failureStreak: 9 }),
    ).toBe("disabled")
  })

  it("is offline when the browser reports no network, ahead of every other signal", () => {
    expect(deriveSyncStatus({ ...healthy, online: false })).toBe("offline")
    expect(
      deriveSyncStatus({ ...healthy, online: false, socketOpen: false, pendingCount: 3, failureStreak: 2 }),
    ).toBe("offline")
  })

  it("is syncing while writes are queued and no drain has failed", () => {
    expect(deriveSyncStatus({ ...healthy, pendingCount: 1 })).toBe("syncing")
  })

  it("is retrying after a single failed drain with writes still queued (not three)", () => {
    expect(deriveSyncStatus({ ...healthy, pendingCount: 1, failureStreak: 1 })).toBe("retrying")
    expect(deriveSyncStatus({ ...healthy, pendingCount: 4, failureStreak: 7 })).toBe("retrying")
  })

  it("retrying outranks a closed socket — the user's own edits not landing matters most", () => {
    expect(
      deriveSyncStatus({ ...healthy, socketOpen: false, pendingCount: 1, failureStreak: 1 }),
    ).toBe("retrying")
  })

  it("does not report retrying from a stale failure streak once the queue is empty", () => {
    expect(deriveSyncStatus({ ...healthy, pendingCount: 0, failureStreak: 3 })).toBe("live")
  })

  it("is reconnecting when online but the project socket is not open", () => {
    expect(deriveSyncStatus({ ...healthy, socketOpen: false })).toBe("reconnecting")
    // A closed socket outranks plain "syncing": the queue drains over HTTP,
    // but the user is not receiving live updates.
    expect(deriveSyncStatus({ ...healthy, socketOpen: false, pendingCount: 2 })).toBe("reconnecting")
  })
})

describe("useFileSync", () => {
  let onLine = true
  beforeEach(() => {
    onLine = true
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => onLine })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const base = {
    doc: null,
    projectId: "p1",
    fileId: "f1",
    username: "u",
    enabled: true,
    session: null,
  }

  it("is reconnecting until the reconciler reports an open socket, then live", () => {
    let open = false
    const reconciler = { isConnected: () => open }
    const { result } = renderHook(() => useFileSync({ ...base, reconciler }))
    expect(result.current.status).toBe("reconnecting")
    expect(result.current.connected).toBe(false)

    open = true
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.status).toBe("live")
    expect(result.current.connected).toBe(true)

    open = false
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.status).toBe("reconnecting")
  })

  it("treats a missing reconciler as a closed socket", () => {
    const { result } = renderHook(() => useFileSync({ ...base, reconciler: null }))
    expect(result.current.status).toBe("reconnecting")
  })

  it("reports syncing then retrying from the outbox inputs while the socket is open", () => {
    const reconciler = { isConnected: () => true }
    const { result, rerender } = renderHook(
      (props: { pendingCount: number; failureStreak: number }) =>
        useFileSync({ ...base, reconciler, ...props }),
      { initialProps: { pendingCount: 0, failureStreak: 0 } },
    )
    expect(result.current.status).toBe("live")
    rerender({ pendingCount: 2, failureStreak: 0 })
    expect(result.current.status).toBe("syncing")
    rerender({ pendingCount: 2, failureStreak: 1 })
    expect(result.current.status).toBe("retrying")
    rerender({ pendingCount: 0, failureStreak: 0 })
    expect(result.current.status).toBe("live")
  })

  it("follows the browser online/offline events", () => {
    const reconciler = { isConnected: () => true }
    const { result } = renderHook(() => useFileSync({ ...base, reconciler }))
    expect(result.current.status).toBe("live")
    act(() => {
      onLine = false
      window.dispatchEvent(new Event("offline"))
    })
    expect(result.current.status).toBe("offline")
    act(() => {
      onLine = true
      window.dispatchEvent(new Event("online"))
    })
    expect(result.current.status).toBe("live")
  })

  it("is disabled when nothing is open, even with an open socket", () => {
    const reconciler = { isConnected: () => true }
    const { result } = renderHook(() => useFileSync({ ...base, enabled: false, reconciler }))
    expect(result.current.status).toBe("disabled")
    expect(result.current.connected).toBe(false)
  })

  it("stops sampling the socket on unmount", () => {
    const isConnected = vi.fn(() => true)
    const { unmount } = renderHook(() => useFileSync({ ...base, reconciler: { isConnected } }))
    const calls = isConnected.mock.calls.length
    unmount()
    vi.advanceTimersByTime(5000)
    expect(isConnected.mock.calls.length).toBe(calls)
  })
})
