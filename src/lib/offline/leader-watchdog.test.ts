import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { watchLeaderLiveness } from "./leader-watchdog"

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
