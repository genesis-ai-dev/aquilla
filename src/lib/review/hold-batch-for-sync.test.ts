import { describe, it, expect, vi, afterEach } from "vitest"
import { holdBatchForSync } from "./hold-batch-for-sync"

afterEach(() => {
  vi.useRealTimers()
})

describe("holdBatchForSync", () => {
  it("does nothing when the outbox is empty or only failed", async () => {
    const flushNow = vi.fn()
    const onWaiting = vi.fn()
    await expect(holdBatchForSync({
      flushNow,
      onWaiting,
      readCounts: async () => ({ count: 2, failed: 2 }),
      subscribe: () => () => {},
    })).resolves.toBe("idle")
    expect(flushNow).not.toHaveBeenCalled()
    expect(onWaiting).not.toHaveBeenCalled()
  })

  it("waits until pending records drain and leaves failed records behind", async () => {
    let counts = { count: 3, failed: 1 }
    let listener: (() => void) | null = null
    const flushNow = vi.fn()
    const onWaiting = vi.fn()
    const pending = holdBatchForSync({
      flushNow,
      onWaiting,
      readCounts: async () => counts,
      subscribe: (cb) => {
        listener = cb
        return () => { listener = null }
      },
    })
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledOnce())
    expect(flushNow).toHaveBeenCalledOnce()
    counts = { count: 1, failed: 1 }
    listener!()
    await expect(pending).resolves.toBe("synced")
    expect(listener).toBeNull()
  })

  it("stops waiting when sync does not finish", async () => {
    vi.useFakeTimers()
    const pending = holdBatchForSync({
      flushNow: () => {},
      onWaiting: () => {},
      timeoutMs: 1_000,
      readCounts: async () => ({ count: 1, failed: 0 }),
      subscribe: () => () => {},
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toBe("timeout")
  })
})
