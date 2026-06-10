/**
 * Tests for useFocusLock — the AD-1 focus-lock client.
 *
 * The hook owns three transitions:
 *   1. claim() → optimistic isHeld=true + sends focus.claim
 *   2. server frame lock.claimed by another user → flips us to read-only
 *      with heldBy populated; stops our renewal timer
 *   3. release() / unmount → sends focus.release + cleans up
 *
 * We drive the hook with a fake WsReconciler that records `send` calls and
 * exposes `feedFrame` from the hook tuple so we can simulate server frames.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useFocusLock } from "./useFocusLock"
import type { ProjectWsClientMessage, ProjectWsServerMessage, WsReconciler } from "@/lib/sync/ws-reconciler"

function makeFakeReconciler(): WsReconciler & { sent: ProjectWsClientMessage[] } {
  const sent: ProjectWsClientMessage[] = []
  return {
    sent,
    isConnected: () => true,
    send: (msg) => {
      sent.push(msg)
      return true
    },
    reconnect: () => undefined,
    close: () => undefined,
  } as WsReconciler & { sent: ProjectWsClientMessage[] }
}

describe("useFocusLock", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("claim() sends focus.claim and flips isHeld optimistically", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "cell-1",
        currentUserId: "alice",
        leaseMs: 30_000,
      }),
    )

    expect(result.current[0].isHeld).toBe(false)
    expect(result.current[0].heldBy).toBeNull()

    act(() => {
      result.current[0].claim()
    })

    expect(result.current[0].isHeld).toBe(true)
    expect(ws.sent).toEqual([{ t: "focus.claim", cellId: "cell-1", leaseMs: 30_000 }])
  })

  it("renews the lease at half-period while held", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
        leaseMs: 30_000,
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    // After 15s — one renewal.
    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(ws.sent).toEqual([
      { t: "focus.claim", cellId: "c", leaseMs: 30_000 },
      { t: "focus.renew", cellId: "c" },
    ])
    // After another 15s — second renewal.
    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(ws.sent.filter((m) => m.t === "focus.renew")).toHaveLength(2)
  })

  it("release() stops renewal + sends focus.release", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
        leaseMs: 30_000,
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    act(() => {
      result.current[0].release()
    })
    expect(result.current[0].isHeld).toBe(false)
    expect(ws.sent.at(-1)).toEqual({ t: "focus.release", cellId: "c" })

    // Advancing past the half-period must NOT emit a renewal.
    const before = ws.sent.length
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(ws.sent.length).toBe(before)
  })

  it("server says another user grabbed the cell → isHeld false, heldBy populated", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    expect(result.current[0].isHeld).toBe(true)

    // Bob's claim arrives.
    const frame: ProjectWsServerMessage = {
      t: "lock.claimed",
      cellId: "c",
      by: { userId: "bob", ts: 1000 },
    }
    act(() => {
      result.current[1](frame)
    })

    expect(result.current[0].isHeld).toBe(false)
    expect(result.current[0].heldBy).toEqual({ userId: "bob", ts: 1000 })

    // Our renewal timer must be cleared — advancing past the period emits nothing.
    const before = ws.sent.length
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(ws.sent.length).toBe(before)
  })

  it("lock.released by the other user clears heldBy", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
      }),
    )
    // First Bob grabs it.
    act(() => {
      result.current[1]({
        t: "lock.claimed",
        cellId: "c",
        by: { userId: "bob", ts: 100 },
      })
    })
    expect(result.current[0].heldBy?.userId).toBe("bob")

    // Bob releases — heldBy clears.
    act(() => {
      result.current[1]({
        t: "lock.released",
        cellId: "c",
        by: { userId: "bob", ts: 200 },
      })
    })
    expect(result.current[0].heldBy).toBeNull()
    expect(result.current[0].isHeld).toBe(false)
  })

  it("ignores lock messages for other cells", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c-a",
        currentUserId: "alice",
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    expect(result.current[0].isHeld).toBe(true)
    act(() => {
      result.current[1]({
        t: "lock.claimed",
        cellId: "c-b",
        by: { userId: "bob", ts: 1 },
      })
    })
    // Our cell wasn't c-b; still held.
    expect(result.current[0].isHeld).toBe(true)
    expect(result.current[0].heldBy).toBeNull()
  })

  it("presence snapshot with another user focused on this cell flips us read-only", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
      }),
    )
    act(() => {
      result.current[1]({
        t: "presence",
        users: [
          { userId: "bob", focusedCell: "c", ts: 1 },
          { userId: "alice", focusedCell: undefined, ts: 2 },
        ],
      })
    })
    expect(result.current[0].heldBy?.userId).toBe("bob")
  })

  it("auto-releases when cellId changes", () => {
    const ws = makeFakeReconciler()
    const { result, rerender } = renderHook(
      ({ cellId }: { cellId: string }) =>
        useFocusLock({
          reconciler: ws,
          cellId,
          currentUserId: "alice",
        }),
      { initialProps: { cellId: "c-1" } },
    )
    act(() => {
      result.current[0].claim()
    })
    expect(ws.sent.at(-1)).toEqual({ t: "focus.claim", cellId: "c-1", leaseMs: 30_000 })

    rerender({ cellId: "c-2" })
    // Switching cells should have queued a release for the previous one.
    expect(ws.sent.some((m) => m.t === "focus.release" && m.cellId === "c-1")).toBe(true)
  })

  it("releases on unmount", () => {
    const ws = makeFakeReconciler()
    const { result, unmount } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    unmount()
    expect(ws.sent.some((m) => m.t === "focus.release" && m.cellId === "c")).toBe(true)
  })

  it("claim() is a no-op when reconciler is null", () => {
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: null,
        cellId: "c",
        currentUserId: "alice",
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    // No fake reconciler to inspect, but isHeld must stay false (we never sent).
    expect(result.current[0].isHeld).toBe(false)
  })

  // FRO-288: renewal keeps the lock alive past the 30s DO lease boundary.
  // Without renewal the DO expires the lease and a second claimant can steal
  // the lock silently. With the half-period timer, focus.renew fires every 15s
  // and the server resets the clock; isHeld stays true on our side.
  it("FRO-288: renewal fires past the 30s lease boundary, keeping the lock", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
        leaseMs: 30_000,
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    expect(result.current[0].isHeld).toBe(true)

    // Advance well past the 30s boundary — renewal should have fired twice.
    act(() => {
      vi.advanceTimersByTime(35_000)
    })
    // Still held locally — the server's clock was reset by the renewals.
    expect(result.current[0].isHeld).toBe(true)
    const renewals = ws.sent.filter((m) => m.t === "focus.renew")
    expect(renewals.length).toBeGreaterThanOrEqual(2)
  })

  // FRO-288: takeover (another user grabs the cell) must surface heldBy
  // and stop our renewal timer so we don't keep sending stale renewals.
  it("FRO-288: takeover sets heldBy and stops the renewal timer", () => {
    const ws = makeFakeReconciler()
    const { result } = renderHook(() =>
      useFocusLock({
        reconciler: ws,
        cellId: "c",
        currentUserId: "alice",
        leaseMs: 30_000,
      }),
    )
    act(() => {
      result.current[0].claim()
    })
    expect(result.current[0].isHeld).toBe(true)

    // Server broadcasts another user's claim (takeover).
    act(() => {
      result.current[1]({
        t: "lock.claimed",
        cellId: "c",
        by: { userId: "bob", ts: 1_000 },
      })
    })

    // isHeld must be false; heldBy must identify the takeover user.
    expect(result.current[0].isHeld).toBe(false)
    expect(result.current[0].heldBy).toEqual({ userId: "bob", ts: 1_000 })

    // Renewal timer must be stopped — no further renewals after the takeover.
    const renewalsBefore = ws.sent.filter((m) => m.t === "focus.renew").length
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(ws.sent.filter((m) => m.t === "focus.renew").length).toBe(renewalsBefore)
  })
})
