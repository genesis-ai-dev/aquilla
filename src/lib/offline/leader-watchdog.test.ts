import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { leaderHasPersisted, watchLeaderLiveness, watchLeaderPersisted } from "./leader-watchdog"

type Status = { isSynced: boolean; pendingCount: number; localHead: string; upstreamHead: string }

function makeStore(initial: Status) {
  let status = initial
  return {
    store: { syncStatus: () => status } as unknown as Parameters<typeof watchLeaderLiveness>[0],
    set: (next: Partial<Status>) => {
      status = { ...status, ...next }
    },
  }
}

const synced: Status = { isSynced: true, pendingCount: 0, localHead: "e0.10", upstreamHead: "e0.10" }
const stuck: Status = { isSynced: false, pendingCount: 3, localHead: "e0.13", upstreamHead: "e0.10" }

describe("watchLeaderLiveness", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("stays quiet while the store is synced", async () => {
    const onStall = vi.fn()
    const { store } = makeStore(synced)
    const stop = watchLeaderLiveness(store, { onStall, stallMs: 5000, checkEveryMs: 1000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onStall).not.toHaveBeenCalled()
    stop()
  })

  it("reports a stall once when writes stay pending with no upstream progress", async () => {
    const onStall = vi.fn()
    const { store } = makeStore(stuck)
    const stop = watchLeaderLiveness(store, { onStall, stallMs: 5000, checkEveryMs: 1000 })

    await vi.advanceTimersByTimeAsync(5000)
    expect(onStall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall).toHaveBeenCalledWith(
      expect.objectContaining({ pendingCount: 3, upstreamHead: "e0.10", localHead: "e0.13", stalledForMs: 5000 }),
    )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    stop()
  })

  it("treats upstream progress as a live-but-busy leader, even if never fully synced", async () => {
    const onStall = vi.fn()
    const { store, set } = makeStore(stuck)
    const stop = watchLeaderLiveness(store, { onStall, stallMs: 5000, checkEveryMs: 1000 })

    for (let head = 11; head <= 40; head++) {
      set({ upstreamHead: `e0.${head}`, localHead: `e0.${head + 3}` })
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(onStall).not.toHaveBeenCalled()
    stop()
  })

  it("calls onRecover when a stalled leader catches up, and can report a later stall again", async () => {
    const onStall = vi.fn()
    const onRecover = vi.fn()
    const { store, set } = makeStore(stuck)
    const stop = watchLeaderLiveness(store, { onStall, onRecover, stallMs: 3000, checkEveryMs: 1000 })

    await vi.advanceTimersByTimeAsync(4000)
    expect(onStall).toHaveBeenCalledTimes(1)

    set(synced)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onRecover).toHaveBeenCalledTimes(1)

    set({ ...stuck, localHead: "e0.12" })
    await vi.advanceTimersByTimeAsync(5000)
    expect(onStall).toHaveBeenCalledTimes(2)
    stop()
  })

  it("stops polling once stopped", async () => {
    const onStall = vi.fn()
    const { store } = makeStore(stuck)
    const stop = watchLeaderLiveness(store, { onStall, stallMs: 3000, checkEveryMs: 1000 })
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onStall).not.toHaveBeenCalled()
  })
})

describe("leaderHasPersisted", () => {
  it("compares global then client sequence numbers", () => {
    expect(leaderHasPersisted("e5.3", "e5.3")).toBe(true)
    expect(leaderHasPersisted("e5.4", "e5.3")).toBe(true)
    expect(leaderHasPersisted("e6", "e5.3")).toBe(true)
    expect(leaderHasPersisted("e5.2", "e5.3")).toBe(false)
    expect(leaderHasPersisted("e5", "e5.1")).toBe(false)
    expect(leaderHasPersisted("e4.9", "e5")).toBe(false)
  })

  it("ignores the rebase generation", () => {
    expect(leaderHasPersisted("e5.3r1", "e5.3")).toBe(true)
  })

  it("treats an unreadable head as not persisted", () => {
    expect(leaderHasPersisted("garbage", "e5.3")).toBe(false)
    expect(leaderHasPersisted("e5.3", "")).toBe(false)
  })
})

describe("watchLeaderPersisted", () => {
  function makeFeed(upstreamHead: string) {
    let current = upstreamHead
    const listeners = new Set<(status: { upstreamHead: string }) => void>()
    const store = {
      syncStatus: () => ({ upstreamHead: current }),
      subscribeSyncStatus: (cb: (status: { upstreamHead: string }) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    } as unknown as Parameters<typeof watchLeaderPersisted>[0]
    return {
      store,
      listeners,
      advance: (next: string) => {
        current = next
        for (const cb of [...listeners]) cb({ upstreamHead: next })
      },
    }
  }

  it("calls back at once when the head is already persisted", () => {
    const { store, listeners } = makeFeed("e3.2")
    const onPersisted = vi.fn()
    watchLeaderPersisted(store, "e3.1", onPersisted)
    expect(onPersisted).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })

  it("calls back once the leader catches up, then unsubscribes", () => {
    const { store, listeners, advance } = makeFeed("e3.0")
    const onPersisted = vi.fn()
    watchLeaderPersisted(store, "e3.2", onPersisted)
    advance("e3.1")
    expect(onPersisted).not.toHaveBeenCalled()
    advance("e3.2")
    advance("e3.3")
    expect(onPersisted).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })

  it("stops waiting when told to", () => {
    const { store, listeners, advance } = makeFeed("e3.0")
    const onPersisted = vi.fn()
    const stop = watchLeaderPersisted(store, "e3.2", onPersisted)
    stop()
    advance("e3.5")
    expect(onPersisted).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })
})
