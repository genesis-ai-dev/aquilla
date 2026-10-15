import { describe, it, expect, vi, beforeEach } from "vitest"

// Keep the user provably-authorized (fail-open role gate) and capture the
// enqueued envelope without touching IDB.
vi.mock("./cqrs-bridge", () => ({ getCqrsOutboxBridge: () => null }))
vi.mock("./outbox", () => ({ enqueueOutboxEvent: vi.fn(async () => {}) }))

import {
  emitCellAudioTrim,
  emitCellLinkSet,
  emitCellRetime,
  emitFileTrackSet,
  emitFileVideoSet,
} from "./events-emit"
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

describe("emitCellAudioTrim", () => {
  it("states BOTH ends, always — absence is what used to get windows wiped", async () => {
    await emitCellAudioTrim({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      audioId: "a1.wav",
      trimStartMs: 304,
      trimEndMs: 3656,
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.kind).toBe("cell.audio.trim")
    expect(ev.cellId).toBe("c1")
    expect(ev.parentId).toBeNull()
    expect(ev.payload).toEqual({ audioId: "a1.wav", trimStartMs: 304, trimEndMs: 3656 })
  })

  it("carries an explicit null to clear a bound back to the clip edge", async () => {
    await emitCellAudioTrim({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      audioId: "a1.wav",
      trimStartMs: null,
      trimEndMs: null,
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    // Present-and-null, never omitted: the projection must be able to tell a
    // clear apart from an event that simply has no opinion about trims.
    expect(Object.keys(ev.payload).sort()).toEqual(["audioId", "trimEndMs", "trimStartMs"])
    expect(ev.payload.trimStartMs).toBeNull()
    expect(ev.payload.trimEndMs).toBeNull()
  })
})

describe("emitCellLinkSet", () => {
  it("puts the SUBTITLE side on the envelope and the cue in the payload", async () => {
    // The split is what lets per-file auth and routing work without a second
    // lookup — the same shape comment.* uses.
    await emitCellLinkSet({
      projectId: "p1",
      fileId: "f-subs",
      cellId: "sub-12",
      toFileId: "f-cues",
      toCellId: "cue-7",
      linked: true,
      origin: "auto",
      confidence: 0.92,
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.kind).toBe("cell.link.set")
    expect(ev.fileId).toBe("f-subs")
    expect(ev.cellId).toBe("sub-12")
    expect(ev.parentId).toBeNull()
    expect(ev.payload).toEqual({
      kind: "text-audio",
      toFileId: "f-cues",
      toCellId: "cue-7",
      linked: true,
      origin: "auto",
      confidence: 0.92,
    })
  })

  it("states linked: false to unlink — never an omitted field", async () => {
    await emitCellLinkSet({
      projectId: "p1", fileId: "f-subs", cellId: "sub-12",
      toFileId: "f-cues", toCellId: "cue-7",
      linked: false, origin: "manual", author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    // Present-and-false, with confidence explicitly null: the projection plain-
    // assigns `linked`, so an absent key could only mean "leave it alone" —
    // the exact ambiguity that wiped every take's trim window in stage 4.5.
    expect(Object.keys(ev.payload).sort()).toEqual([
      "confidence", "kind", "linked", "origin", "toCellId", "toFileId",
    ])
    expect(ev.payload.linked).toBe(false)
    expect(ev.payload.confidence).toBeNull()
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

// Stage 1 (first-class timeline tracks). No caller until stage 3, so these
// tests are the only thing pinning the wire shape the sync-worker handler
// already validates against — the payload has to reach it verbatim.
describe("emitFileTrackSet", () => {
  it("enqueues a file.track.set with the patch passed through untouched", async () => {
    await emitFileTrackSet({
      projectId: "p1",
      fileId: "f1",
      trackId: "source-audio",
      patch: { name: "Dialogue", order: 3, groupId: null },
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.kind).toBe("file.track.set")
    expect(ev.fileId).toBe("f1")
    // Not chain-mutating: it never touches a cell, so there is no chain head.
    expect(ev.parentId).toBeNull()
    expect(ev.payload).toEqual({
      trackId: "source-audio",
      patch: { name: "Dialogue", order: 3, groupId: null },
    })
  })

  it("carries a kind through for a user-added track", async () => {
    await emitFileTrackSet({
      projectId: "p1",
      fileId: "f1",
      trackId: "trk-fr",
      patch: { kind: "target-audio", name: "French", order: 4 },
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.payload).toEqual({
      trackId: "trk-fr",
      patch: { kind: "target-audio", name: "French", order: 4 },
    })
  })

  it("supports deleting the whole entry with patch: null", async () => {
    await emitFileTrackSet({
      projectId: "p1",
      fileId: "f1",
      trackId: "trk-fr",
      patch: null,
      author: "u",
    })
    const ev = mockEnqueue.mock.calls.at(-1)![0] as any
    expect(ev.kind).toBe("file.track.set")
    expect(ev.payload).toEqual({ trackId: "trk-fr", patch: null })
  })
})
