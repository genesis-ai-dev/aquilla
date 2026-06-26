import { describe, it, expect, vi, beforeEach } from "vitest"

// Keep the user provably-authorized (fail-open role gate) and capture the
// enqueued envelope without touching IDB.
vi.mock("./cqrs-bridge", () => ({ getCqrsOutboxBridge: () => null }))
vi.mock("./outbox", () => ({ enqueueOutboxEvent: vi.fn(async () => {}) }))

import { emitCellRetime, emitFileVideoSet } from "./events-emit"
import { enqueueOutboxEvent } from "./outbox"

const mockEnqueue = enqueueOutboxEvent as unknown as ReturnType<typeof vi.fn>
beforeEach(() => mockEnqueue.mockClear())

describe("emitCellRetime", () => {
  it("enqueues a cell.retime with ms timing; cellId on the envelope", async () => {
    await emitCellRetime({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      startMs: 400,
      endMs: 6000,
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.kind).toBe("cell.retime")
    expect(ev.fileId).toBe("f1")
    expect(ev.cellId).toBe("c1")
    expect(ev.parentId).toBeNull()
    expect(ev.payload).toEqual({ startMs: 400, endMs: 6000 })
  })
})

describe("emitFileVideoSet", () => {
  it("enqueues a file.video.set with the url", async () => {
    await emitFileVideoSet({
      projectId: "p1",
      fileId: "f1",
      coreMediaUrl: "https://cdn/v.mp4",
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.kind).toBe("file.video.set")
    expect(ev.fileId).toBe("f1")
    expect(ev.payload).toEqual({ coreMediaUrl: "https://cdn/v.mp4" })
  })

  it("supports clearing the link with null", async () => {
    await emitFileVideoSet({ projectId: "p1", fileId: "f1", coreMediaUrl: null, author: "u" })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.payload).toEqual({ coreMediaUrl: null })
  })
})
