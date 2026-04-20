import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { commitMetaEdit, getMetaEditsArray } from "./commit-meta-edit"
import { snapshotEntry } from "./yjs-helpers"

describe("commitMetaEdit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("appends a new entry and never seeds validatedBy (FileEditHistory shape)", () => {
    const doc = new Y.Doc()
    commitMetaEdit(doc, ["videoUrl"], "https://example.com/a.mp4", "alice", "human")
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice"])
    expect(snap.editMap).toEqual(["videoUrl"])
    expect(snap.value).toBe("https://example.com/a.mp4")
    expect(snap.validatedBy).toEqual([])
  })

  it("extends the last entry in place for same-author within 5 min", () => {
    const doc = new Y.Doc()
    commitMetaEdit(doc, ["videoUrl"], "v1", "alice", "human")
    vi.advanceTimersByTime(60_000)
    commitMetaEdit(doc, ["videoUrl"], "v2", "alice", "human")
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(1)
    expect(snapshotEntry(arr.get(0)).value).toBe("v2")
  })

  it("appends a new entry when editMap differs", () => {
    const doc = new Y.Doc()
    commitMetaEdit(doc, ["videoUrl"], "v1", "alice", "human")
    vi.advanceTimersByTime(60_000)
    commitMetaEdit(doc, ["corpusMarker"], "OT", "alice", "human")
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(2)
  })
})
