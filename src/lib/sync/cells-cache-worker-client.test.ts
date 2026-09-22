import { afterEach, describe, expect, it, vi } from "vitest"
import type { CellRow } from "./cells-read-types"
import { readCellsCache, resetCellsCacheConnectionForTests, setCellsCacheOwner, writeCellsCache, scheduleCellsCacheWrite, flushCellsCacheWrites } from "./cells-cache"
import { createCacheWriterReceiver, CELLS_CACHE_BATCH_ROWS, type CacheWriterMessage } from "./cells-cache-writer"

// Bridge the actual sender to the actual receiver through structured cloning;
// fake-indexeddb remains the real storage implementation for these tests.
class TestWorker {
  static instances: TestWorker[] = []
  onmessage?: (event: { data: { ok: boolean } }) => void
  onerror?: () => void
  onmessageerror?: () => void
  receive = createCacheWriterReceiver()
  messages: CacheWriterMessage[] = []
  terminated = false
  constructor() { TestWorker.instances.push(this) }
  postMessage(message: CacheWriterMessage) {
    const copy = structuredClone(message)
    this.messages.push(copy)
    void this.receive(copy).then(
      () => this.onmessage?.({ data: { ok: true } }),
      () => this.onmessage?.({ data: { ok: false } }),
    )
  }
  terminate() { this.terminated = true }
}

function rows(count: number): CellRow[] {
  return Array.from({ length: count }, (_, i) => ({
    cellId: `cell-${i}`, side: i % 2 ? "target" : "source",
    targetLang: i % 2 ? "fr-CA" : "", value: `Text ${i} — 漢字`, valueHtml: null,
    type: null, canonicalRef: null, anchorCellId: null, eventId: `event-${i}`,
    sourceEventId: null, lastEditor: null, lastEditAt: i, validated: false,
    wordCount: 2, metadata: { nested: { parts: ["a", null, 0] } },
  }))
}

afterEach(async () => {
  vi.useRealTimers()
  await resetCellsCacheConnectionForTests()
  TestWorker.instances = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("large cells cache worker", () => {
  it("round-trips every lane and the snapshot cursor through bounded cloned batches", async () => {
    vi.stubGlobal("Worker", TestWorker)
    setCellsCacheOwner("writer-alice")
    const snapshot = rows(CELLS_CACHE_BATCH_ROWS * 2 + 3)
    const write = writeCellsCache("worker-project", "file", snapshot, 42, 100)
    setCellsCacheOwner("writer-bob")
    await write
    expect(await readCellsCache("worker-project", "file")).toBeNull()
    setCellsCacheOwner("writer-alice")
    expect(await readCellsCache("worker-project", "file")).toMatchObject({
      rows: snapshot, maxServerSeq: 42, projectEpoch: 100, maxLastEditAt: snapshot.length - 1,
    })
    const worker = TestWorker.instances[0]
    expect(worker.messages.map(m => m.type)).toEqual(["start", "rows", "rows", "rows", "commit"])
    expect(worker.messages.filter(m => m.type === "rows").map(m => m.rows.length)).toEqual([500, 500, 3])
    expect(worker.terminated).toBe(true)
    // Replacing with a smaller complete snapshot removes old rows and cursors.
    await writeCellsCache("worker-project", "file", snapshot.slice(0, 501))
    const smaller = await readCellsCache("worker-project", "file")
    expect(smaller?.rows).toEqual(snapshot.slice(0, 501))
    expect(smaller?.maxServerSeq).toBeUndefined()
    expect(smaller?.projectEpoch).toBeUndefined()
  })

  it("retains the previous atomic snapshot after a worker failure, then recovers", async () => {
    await writeCellsCache("failed-worker", "file", rows(1), 1)
    class FailedWorker extends TestWorker {
      override postMessage() { queueMicrotask(() => this.onerror?.()) }
    }
    vi.stubGlobal("Worker", FailedWorker)
    const put = vi.spyOn(IDBObjectStore.prototype, "put")
    await writeCellsCache("failed-worker", "file", rows(501), 2)
    expect(put).not.toHaveBeenCalled() // No blocking main-thread fallback.
    expect((await readCellsCache("failed-worker", "file"))?.maxServerSeq).toBe(1)
    expect(TestWorker.instances[0].terminated).toBe(true)
    vi.stubGlobal("Worker", TestWorker)
    await writeCellsCache("failed-worker", "file", rows(501), 3)
    expect((await readCellsCache("failed-worker", "file"))?.maxServerSeq).toBe(3)
  })

  it("drains a newer queued snapshot after an in-flight worker without mixing cursors", async () => {
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const committing = new Promise<void>(resolve => { started = resolve })
    class HeldWorker extends TestWorker {
      override postMessage(message: CacheWriterMessage) {
        if (message.type === "commit" && TestWorker.instances.length === 1) {
          started()
          void held.then(() => super.postMessage(message))
        } else super.postMessage(message)
      }
    }
    vi.stubGlobal("Worker", HeldWorker)
    scheduleCellsCacheWrite("queued-worker", "file", rows(502), 42, 100)
    const flushing = flushCellsCacheWrites("queued-worker", "file")
    await committing
    scheduleCellsCacheWrite("queued-worker", "file", rows(501), 1, 200)
    release()
    await flushing
    const result = await readCellsCache("queued-worker", "file")
    expect(result?.rows).toHaveLength(501)
    expect(result?.maxServerSeq).toBe(1)
    expect(result?.projectEpoch).toBe(200)
    expect(TestWorker.instances).toHaveLength(2)
    expect(TestWorker.instances.every(worker => worker.terminated)).toBe(true)
  })

  it("immediate writes detach their arrays and supersede older queued snapshots", async () => {
    vi.stubGlobal("Worker", TestWorker)
    scheduleCellsCacheWrite("direct-worker", "file", rows(503), 99, 100)
    const snapshot = rows(501)
    const expected = snapshot.slice()
    const write = writeCellsCache("direct-worker", "file", snapshot, 1, 200)
    snapshot.splice(0, snapshot.length)
    await write
    await flushCellsCacheWrites("direct-worker", "file")
    expect(await readCellsCache("direct-worker", "file")).toMatchObject({
      rows: expected, maxServerSeq: 1, projectEpoch: 200,
    })
    expect(TestWorker.instances).toHaveLength(1)
  })

  it("preserves the previous cache when the final worker transaction fails", async () => {
    await writeCellsCache("commit-failure", "file", rows(1), 1)
    vi.stubGlobal("Worker", TestWorker)
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new Error("quota") })
    await writeCellsCache("commit-failure", "file", rows(501), 2)
    expect((await readCellsCache("commit-failure", "file"))?.maxServerSeq).toBe(1)
    expect(TestWorker.instances[0].terminated).toBe(true)
  })

  it("times out and terminates an unresponsive worker without blocking flush forever", async () => {
    // Open the cache before fake timers so IndexedDB's own timers can settle.
    await writeCellsCache("timeout-worker", "file", rows(1), 1)
    class HungWorker extends TestWorker { override postMessage() {} }
    vi.stubGlobal("Worker", HungWorker)
    vi.useFakeTimers()
    const write = writeCellsCache("timeout-worker", "file", rows(501), 2)
    await vi.advanceTimersByTimeAsync(60_000)
    await write
    expect(TestWorker.instances[0].terminated).toBe(true)
    vi.useRealTimers()
    expect((await readCellsCache("timeout-worker", "file"))?.maxServerSeq).toBe(1)
  })
})
