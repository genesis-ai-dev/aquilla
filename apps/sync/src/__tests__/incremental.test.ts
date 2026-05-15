// The sync-worker's onSave originally wrote Y.encodeStateAsUpdate(doc) on
// every save — a full state dump. That blew past the 128 MiB DO isolate
// limit on files edited over long sessions (50 full dumps × a sizeable doc
// = OOM during onLoad/compaction). encodeNextTail replaces that with an
// incremental diff against the last flushed state vector, plus a pristine-
// doc guard for the very first save after a cold start.

import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { encodeNextTail } from "../incremental"

describe("encodeNextTail", () => {
  it("returns the full state on the first call (no prior state vector)", () => {
    const doc = new Y.Doc()
    doc.getMap("cells").set("cell-1", "hello")

    const result = encodeNextTail(doc, null)

    expect(result).not.toBeNull()
    const fullState = Y.encodeStateAsUpdate(doc)
    expect(result!.update).toEqual(fullState)
    expect(result!.newSV).toEqual(Y.encodeStateVector(doc))
    doc.destroy()
  })

  it("returns only the incremental diff on subsequent calls", () => {
    const doc = new Y.Doc()
    // Non-trivial baseline so the full state is meaningfully larger than a
    // small delta (Yjs has fixed per-update overhead that dominates at
    // kilobyte-scale payloads).
    const cells = doc.getMap("cells")
    for (let i = 0; i < 100; i++) cells.set(`cell-${i}`, "x".repeat(64))
    const first = encodeNextTail(doc, null)!

    cells.set("cell-new", "tiny edit")
    const second = encodeNextTail(doc, first.newSV)!

    // The actual invariant we care about: an incremental tail must be much
    // smaller than a full state dump of the same doc at the same moment.
    // That's what keeps DO memory and R2 bloat bounded.
    const fullStateAtT2 = Y.encodeStateAsUpdate(doc)
    expect(second.update.byteLength).toBeLessThan(fullStateAtT2.byteLength / 2)

    // And applying `first` then `second` to a fresh doc must reproduce state.
    const replay = new Y.Doc()
    Y.applyUpdate(replay, first.update)
    Y.applyUpdate(replay, second.update)
    expect(replay.getMap("cells").get("cell-new")).toBe("tiny edit")
    expect(replay.getMap("cells").get("cell-0")).toBe("x".repeat(64))
    replay.destroy()
    doc.destroy()
  })

  it("returns null when the doc hasn't advanced since the last flush", () => {
    const doc = new Y.Doc()
    doc.getMap("cells").set("cell-1", "hello")
    const first = encodeNextTail(doc, null)!

    // No edits between calls — the diff is empty, nothing to persist.
    const second = encodeNextTail(doc, first.newSV)

    expect(second).toBeNull()
    doc.destroy()
  })

  it("round-trips through many incremental tails", () => {
    // Simulates a long editing session: substantial baseline + a chain of
    // small incremental tails. Replaying them in order must reproduce the
    // live doc's state, matching the existing compaction invariant test.
    const doc = new Y.Doc()
    const cells = doc.getMap("cells")
    for (let i = 0; i < 100; i++) cells.set(`base-${i}`, "x".repeat(64))

    const updates: Uint8Array[] = []
    let sv: Uint8Array | null = null

    for (let i = 0; i < 20; i++) {
      cells.set(`cell-${i}`, `v${i}`)
      const tail = encodeNextTail(doc, sv)
      if (tail) {
        updates.push(tail.update)
        sv = tail.newSV
      }
    }

    // The first tail is a full dump of the baseline + cell-0; every later
    // tail is a 1-cell delta that must be much smaller. That's how we keep
    // DO memory bounded during long sessions.
    const first = updates[0].byteLength
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i].byteLength).toBeLessThan(first / 4)
    }

    const replay = new Y.Doc()
    for (const u of updates) Y.applyUpdate(replay, u)
    for (let i = 0; i < 20; i++) {
      expect(replay.getMap("cells").get(`cell-${i}`)).toBe(`v${i}`)
    }
    expect(replay.getMap("cells").get("base-0")).toBe("x".repeat(64))
    replay.destroy()
    doc.destroy()
  })
})
