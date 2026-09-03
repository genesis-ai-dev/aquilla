import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useFocusLock } from "./useFocusLock"
import { applyFocusClaim } from "../../sync-worker/src/project-do-handlers"
import type { ProjectWsClientMessage, WsReconciler } from "@/lib/sync/ws-reconciler"

function setup() {
  const ws: WsReconciler = {
    isConnected: vi.fn(() => true),
    send: vi.fn((_msg: ProjectWsClientMessage) => true),
    reconnect: vi.fn(), close: vi.fn(),
  }
  const hook = renderHook(({ cellId, connected }) => useFocusLock({
    reconciler: ws, cellId, connected, currentUserId: "alice", leaseMs: 30_000,
  }), { initialProps: { cellId: "c", connected: true } })
  const claim = () => act(() => hook.result.current[0].claim())
  // Real DO producer -> client consumer, not a hand-written acknowledgement.
  const acknowledge = () => act(() => {
    const response = applyFocusClaim(new Map(), new Map(), "alice", { t: "focus.claim", cellId: "c", leaseMs: 30_000 }, Date.now())
    for (const frame of response.emit) hook.result.current[1](frame)
  })
  return { ...hook, ws, claim, acknowledge }
}

describe("acknowledged focus leases", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("stays read-only until the real DO acknowledges the claim", () => {
    const h = setup()
    h.claim()
    expect(h.result.current[0].isHeld).toBe(false)
    expect(h.result.current[0].heldCellId).toBeNull()
    expect(h.ws.send).toHaveBeenCalledWith({ t: "focus.claim", cellId: "c", leaseMs: 30_000 })
    h.acknowledge()
    expect(h.result.current[0].isHeld).toBe(true)
    expect(h.result.current[0].heldCellId).toBe("c")
  })

  it("does not claim success or renew after send returns false", () => {
    const h = setup()
    vi.mocked(h.ws.send).mockReturnValue(false)
    h.claim()
    act(() => vi.advanceTimersByTime(60_000))
    expect(h.result.current[0].isHeld).toBe(false)
    expect(h.ws.send).toHaveBeenCalledTimes(1)
  })

  it("does not resend or extend a pending claim when activation repeats", () => {
    const h = setup()
    h.claim()
    act(() => vi.advanceTimersByTime(10_000))
    h.claim()
    expect(h.ws.send).toHaveBeenCalledTimes(1)
    h.acknowledge()
    act(() => vi.advanceTimersByTime(20_000))
    expect(h.result.current[0].isHeld).toBe(false)
  })

  it("renews with acknowledgement while keeping a still-valid lease writable", () => {
    const h = setup()
    h.claim(); h.acknowledge()
    act(() => vi.advanceTimersByTime(15_000))
    expect(h.ws.send).toHaveBeenCalledTimes(2)
    expect(h.result.current[0].isHeld).toBe(true)
    h.acknowledge()
    act(() => vi.advanceTimersByTime(16_000))
    expect(h.result.current[0].isHeld).toBe(true)
    h.acknowledge()
    expect(h.result.current[0].isHeld).toBe(true)
  })

  it("expires locally when the socket stays open but renewal replies are lost", () => {
    const h = setup()
    h.claim(); h.acknowledge()
    act(() => vi.advanceTimersByTime(30_000))
    expect(h.result.current[0].isHeld).toBe(false)
  })

  it("does not extend the lease by the acknowledgement's network delay", () => {
    const h = setup()
    h.claim()
    act(() => vi.advanceTimersByTime(10_000))
    h.acknowledge()
    act(() => vi.advanceTimersByTime(20_000))
    expect(h.result.current[0].isHeld).toBe(false)
  })

  it("reconnects after an expired unanswered claim and ignores its late echo", () => {
    const h = setup()
    h.claim()
    act(() => vi.advanceTimersByTime(30_000))
    expect(h.ws.reconnect).toHaveBeenCalledOnce()
    h.acknowledge()
    expect(h.result.current[0].isHeld).toBe(false)
  })

  it("pauses on disconnect and requires a fresh acknowledgement after reconnect", () => {
    const h = setup()
    h.claim(); h.acknowledge()
    h.rerender({ cellId: "c", connected: false })
    expect(h.result.current[0].isHeld).toBe(false)
    h.rerender({ cellId: "c", connected: true })
    expect(h.result.current[0].isHeld).toBe(false)
    h.acknowledge()
    expect(h.result.current[0].isHeld).toBe(true)
  })

  it("denial and another holder's presence stop renewal", () => {
    const h = setup()
    h.claim(); h.acknowledge()
    act(() => h.result.current[1]({ t: "lock.claimed", cellId: "c", by: { userId: "bob", ts: 1 } }))
    expect(h.result.current[0].isHeld).toBe(false)
    expect(h.result.current[0].heldBy?.userId).toBe("bob")
    const sent = vi.mocked(h.ws.send).mock.calls.length
    act(() => vi.advanceTimersByTime(60_000))
    expect(h.ws.send).toHaveBeenCalledTimes(sent)
    act(() => h.result.current[1]({ t: "lock.released", cellId: "c", by: { userId: "bob", ts: 2 } }))
    expect(h.result.current[0].heldBy).toBeNull()
    act(() => h.result.current[1]({ t: "presence", users: [{ userId: "bob", focusedCell: "c", ts: 3 }] }))
    expect(h.result.current[0].heldBy?.userId).toBe("bob")
  })

  it("ignores other cells and acknowledgements after release", () => {
    const h = setup()
    h.claim(); h.acknowledge()
    act(() => h.result.current[1]({ t: "lock.claimed", cellId: "other", by: { userId: "bob", ts: 1 } }))
    expect(h.result.current[0].isHeld).toBe(true)
    act(() => h.result.current[0].release())
    h.acknowledge()
    expect(h.result.current[0].isHeld).toBe(false)
    expect(h.ws.send).toHaveBeenLastCalledWith({ t: "focus.release", cellId: "c" })
  })

  it("releases on cell change and unmount", () => {
    const h = setup()
    h.claim(); h.acknowledge()
    h.rerender({ cellId: "other", connected: true })
    expect(h.result.current[0].isHeld).toBe(false)
    expect(h.ws.send).toHaveBeenLastCalledWith({ t: "focus.release", cellId: "c" })
    h.claim()
    h.unmount()
    expect(h.ws.send).toHaveBeenLastCalledWith({ t: "focus.release", cellId: "other" })
  })

  it("is read-only without a reconciler", () => {
    const { result } = renderHook(() => useFocusLock({ reconciler: null, cellId: "c", currentUserId: "alice" }))
    act(() => result.current[0].claim())
    expect(result.current[0].isHeld).toBe(false)
  })
})
