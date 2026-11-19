// A Transcribe row does not wait for its save to be flushed (AQU-2654), so
// something else has to notice a save that never lands. This is that: it
// watches the outbox for the view's own words writes, and reports the one the
// flusher has given up on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface FakeRecord {
  id: string
  enqueuedAt: number
  status: "pending" | "failed"
  lastError: { status: number; reason: string } | null
  event: { cellId: string; kind: string; payload: Record<string, unknown> }
}

const outbox = vi.hoisted(() => ({
  records: [] as unknown[],
  listeners: new Set<() => void>(),
  reads: 0,
}))
vi.mock("@/lib/sync/outbox", () => ({
  getOutboxFileAudioRecords: async () => {
    outbox.reads += 1
    return outbox.records
  },
  subscribeToOutbox: (listener: () => void) => {
    outbox.listeners.add(listener)
    return () => outbox.listeners.delete(listener)
  },
}))

import { SAVE_WATCH_DELAY_MS, watchTranscriptWrites } from "./save-watch"

const words = (cellId: string, over: Partial<FakeRecord> = {}): FakeRecord => ({
  id: `evt-${cellId}`, enqueuedAt: 1_000, status: "pending", lastError: null,
  event: { cellId, kind: "cell.audio.attach", payload: { wordsOnly: true } },
  ...over,
})
const moved = async () => {
  outbox.listeners.forEach((listener) => listener())
  await vi.advanceTimersByTimeAsync(SAVE_WATCH_DELAY_MS + 10)
}

describe("watchTranscriptWrites", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    outbox.records = []
    outbox.listeners.clear()
    outbox.reads = 0
  })
  afterEach(() => { vi.useRealTimers() })

  it("reports a save the outbox has given up on, once, with the server's reason", async () => {
    const onFailed = vi.fn()
    const watch = watchTranscriptWrites({ projectId: "p1", onFailed })
    outbox.records = [words("c1")]
    watch.note("f1", "c1", 1_000)
    await moved()
    // Still queued: the flusher is retrying it, nothing to say yet.
    expect(onFailed).not.toHaveBeenCalled()

    outbox.records = [words("c1", { status: "failed", lastError: { status: 403, reason: "forbidden" } })]
    await moved()
    expect(onFailed).toHaveBeenCalledExactlyOnceWith("c1", "403 forbidden")
    await moved()
    expect(onFailed).toHaveBeenCalledTimes(1)
  })

  it("stops watching, and listening to the outbox, once every save has been delivered", async () => {
    const onFailed = vi.fn()
    const watch = watchTranscriptWrites({ projectId: "p1", onFailed })
    outbox.records = [words("c1"), words("c2")]
    watch.note("f1", "c1", 1_000)
    watch.note("f1", "c2", 1_000)
    expect(outbox.listeners.size).toBe(1)
    outbox.records = []
    await moved()
    expect(onFailed).not.toHaveBeenCalled()
    expect(outbox.listeners.size).toBe(0)
    const reads = outbox.reads
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outbox.reads).toBe(reads)
  })

  it("does not blame a new save for an older stuck write of the same line, or for another kind of write", async () => {
    const onFailed = vi.fn()
    const watch = watchTranscriptWrites({ projectId: "p1", onFailed })
    outbox.records = [
      words("c1", { id: "old", enqueuedAt: 10, status: "failed" }),
      { ...words("c1", { id: "take", status: "failed" }), event: { cellId: "c1", kind: "cell.audio.attach", payload: {} } },
    ]
    watch.note("f1", "c1", 1_000)
    await moved()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it("reports nothing after the view has gone", async () => {
    const onFailed = vi.fn()
    const watch = watchTranscriptWrites({ projectId: "p1", onFailed })
    outbox.records = [words("c1", { status: "failed" })]
    watch.note("f1", "c1", 1_000)
    watch.stop()
    await moved()
    expect(onFailed).not.toHaveBeenCalled()
    expect(outbox.listeners.size).toBe(0)
  })
})
